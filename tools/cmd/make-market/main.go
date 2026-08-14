// make-market rests a two-sided ladder into a batch and clears it.
//
// Every earlier demo crossed one buyer against one seller, which proves the
// plumbing but not the auction: matched volume equalled every order, so the
// venue's most distinctive property — that orders which do not trade are
// destroyed inside the enclave and never published — was never visible.
//
// This builds a batch with actual depth. A market maker rests bids and offers
// either side of the oracle; a taker crosses part of it. Some of the ladder
// fills, most of it does not, and the chain learns nothing about the part that
// did not.
//
// A single address may rest many orders — the venue binds each to its
// submitter, which is exactly how a market maker quotes.
package main

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"flag"
	"fmt"
	"math/big"
	"strings"
	"time"

	"extension-scaffold/tools/pkg/configs"
	"extension-scaffold/tools/pkg/contracts/nightjarauction"
	"extension-scaffold/tools/pkg/fccutils"
	"extension-scaffold/tools/pkg/support"
	instrutils "extension-scaffold/tools/pkg/utils"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"
	"github.com/pkg/errors"
)

var priceScale = new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)

const sixDecimals = 1_000_000

type sealedOrder struct {
	Trader     string `json:"trader"`
	Side       uint8  `json:"side"`
	LimitPrice string `json:"limitPrice"`
	Size       string `json:"size"`
	Nonce      string `json:"nonce"`
}

type fill struct {
	Trader     common.Address `json:"trader"`
	BaseDelta  *big.Int       `json:"baseDelta"`
	QuoteDelta *big.Int       `json:"quoteDelta"`
}

type runBatchResponse struct {
	BatchID       uint64   `json:"batchId"`
	ClearingPrice *big.Int `json:"clearingPrice"`
	MatchedBase   *big.Int `json:"matchedBase"`
	Fills         []fill   `json:"fills"`
	Settlement    []byte   `json:"settlement"`
	Signature     []byte   `json:"signature"`
	Unmatched     int      `json:"unmatched"`
}

// one rung of the ladder
type quote struct {
	who   string // "mm" or "taker"
	side  uint8  // 0 buy, 1 sell
	price string
	size  string
}

func main() {
	af := flag.String("a", configs.AddressesFile, "deployed addresses")
	cf := flag.String("c", configs.ChainNodeURL, "chain node url")
	pf := flag.String("p", configs.ExtensionProxyURL, "extension proxy url")
	venueF := flag.String("venue", "", "NightjarAuction address")
	takerKeyF := flag.String("taker", "", "hex key for the taker")
	flag.Parse()

	venue := common.HexToAddress(*venueF)

	s, err := support.DefaultSupport(*af, *cf)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	mm := s.Prv // the deployer plays market maker
	taker, err := crypto.HexToECDSA(strings.TrimPrefix(*takerKeyF, "0x"))
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("bad taker key: %s", err))
	}

	auction, err := nightjarauction.NewNightjarAuction(venue, s.ChainClient)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	teeInfo, err := fccutils.TeeInfo(*pf)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("fetching TEE info: %s", err))
	}
	teePubKey, err := teetypes.ParsePubKey(teeInfo.TeeInfoResponse.TeeInfo.PublicKey)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	batchID, err := auction.CurrentBatchId(&bind.CallOpts{})
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	// A two-sided ladder around the oracle, plus one aggressive seller.
	// Only the rung that actually crosses will trade.
	ladder := []quote{
		{"mm", 0, "0.99", "1.0"},  // bid, too low to cross
		{"mm", 0, "1.01", "1.0"},  // bid, crosses the taker
		{"mm", 1, "1.03", "1.0"},  // offer, nobody lifts it
		{"mm", 1, "1.05", "1.0"},  // offer, nobody lifts it
		{"taker", 1, "1.00", "1.0"}, // sells into the book
	}

	logger.Infof("Batch %d — resting a two-sided ladder", batchID)
	logger.Infof("")
	for _, q := range ladder {
		key := mm
		label := "maker"
		if q.who == "taker" {
			key = taker
			label = "taker"
		}
		who := crypto.PubkeyToAddress(key.PublicKey)

		side := "BUY "
		if q.side == 1 {
			side = "SELL"
		}
		logger.Infof("  %s  %s %s @ %s", label, side, q.size, q.price)

		submit(s, key, who, venue, teePubKey, sealedOrder{
			Trader:     who.Hex(),
			Side:       q.side,
			LimitPrice: scaled(q.price).String(),
			Size:       parseAmount(q.size).String(),
			Nonce:      fmt.Sprintf("%d-%s-%s", time.Now().UnixNano(), q.side, q.price),
		})
	}

	count, err := auction.BatchOrderCount(&bind.CallOpts{}, batchID)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("")
	logger.Infof("%d orders resting. The chain knows only that number.", count)
	logger.Infof("Clearing…")

	instructionID, _, err := instrutils.RunBatch(s, venue)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("runBatch: %s", err))
	}

	result, err := pollResult(*pf, instructionID)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("polling: %s", err))
	}
	var settlement runBatchResponse
	if err := json.Unmarshal(result.Data, &settlement); err != nil {
		fccutils.FatalWithCause(err)
	}

	logger.Infof("")
	logger.Infof("── cleared ──────────────────────────────────")
	logger.Infof("  price          %s", fmtPrice(settlement.ClearingPrice))
	logger.Infof("  matched        %s FXRP of %d resting orders", fmtAmount(settlement.MatchedBase), count)
	logger.Infof("  traders filled %d", len(settlement.Fills))
	logger.Infof("  NEVER REVEALED %d orders — terms destroyed inside the enclave", settlement.Unmatched)
	logger.Infof("")

	opts := mustAuth(s.Prv, s.ChainID)
	opts.GasLimit = 1_500_000
	tx, err := auction.Settle(opts, settlement.Settlement, [][]byte{settlement.Signature})
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("settle: %s", err))
	}
	mustMine(s, tx, "settle")
	logger.Infof("Settled: %s", tx.Hash().Hex())
	logger.Infof("")
	logger.Infof("The chain now holds: a clearing price, a matched volume, and")
	logger.Infof("per-trader net deltas. Of the %d orders that did not trade it", settlement.Unmatched)
	logger.Infof("holds nothing at all — not the side, the price, or the size.")
}

func submit(
	s *support.Support,
	key *ecdsa.PrivateKey,
	who common.Address,
	venue common.Address,
	teePubKey *ecdsa.PublicKey,
	order sealedOrder,
) {
	plaintext, err := json.Marshal(order)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	ciphertext, err := teeutils.Encrypt(plaintext, teePubKey)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("encrypting: %s", err))
	}

	signer := *s
	signer.Prv = key
	if _, _, err := instrutils.SubmitOrder(&signer, venue, ciphertext); err != nil {
		fccutils.FatalWithCause(errors.Errorf("submitOrder for %s: %s", who.Hex(), err))
	}
	// Let the enclave take delivery before the next one lands.
	time.Sleep(3 * time.Second)
}

func pollResult(proxyURL string, id common.Hash) (*teetypes.ActionResult, error) {
	for i := 0; i < 40; i++ {
		time.Sleep(3 * time.Second)
		resp, err := fccutils.ActionResult(proxyURL, id)
		if err != nil {
			continue
		}
		r := resp.Result
		if r.Status == 0 {
			return nil, errors.Errorf("batch abandoned: %s", r.Log)
		}
		if r.Status != 2 {
			return &r, nil
		}
	}
	return nil, errors.New("timed out")
}

func mustAuth(key *ecdsa.PrivateKey, chainID *big.Int) *bind.TransactOpts {
	opts, err := bind.NewKeyedTransactorWithChainID(key, chainID)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	return opts
}

func mustMine(s *support.Support, tx *types.Transaction, what string) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	receipt, err := bind.WaitMined(ctx, s.ChainClient, tx)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("%s not mined: %s", what, err))
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		fccutils.FatalWithCause(errors.Errorf("%s reverted (tx %s)", what, tx.Hash().Hex()))
	}
}

func scaled(dec string) *big.Int {
	parts := strings.SplitN(dec, ".", 2)
	whole, _ := new(big.Int).SetString(parts[0], 10)
	out := new(big.Int).Mul(whole, priceScale)
	if len(parts) == 2 {
		frac, _ := new(big.Int).SetString(parts[1], 10)
		scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(len(parts[1]))), nil)
		out.Add(out, new(big.Int).Div(new(big.Int).Mul(frac, priceScale), scale))
	}
	return out
}

func parseAmount(dec string) *big.Int {
	parts := strings.SplitN(dec, ".", 2)
	whole, _ := new(big.Int).SetString(parts[0], 10)
	out := new(big.Int).Mul(whole, big.NewInt(sixDecimals))
	if len(parts) == 2 {
		frac := (parts[1] + "000000")[:6]
		f, _ := new(big.Int).SetString(frac, 10)
		out.Add(out, f)
	}
	return out
}

func fmtPrice(p *big.Int) string {
	q := new(big.Int).Div(p, priceScale)
	r := new(big.Int).Mod(p, priceScale)
	return fmt.Sprintf("%s.%s", q, fmt.Sprintf("%018s", r.String())[:4])
}

func fmtAmount(v *big.Int) string {
	unit := big.NewInt(sixDecimals)
	q := new(big.Int).Div(v, unit)
	r := new(big.Int).Mod(v, unit)
	frac := r.String()
	for len(frac) < 6 {
		frac = "0" + frac
	}
	return fmt.Sprintf("%s.%s", q, frac)
}

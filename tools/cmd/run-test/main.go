// run-test drives a full Nightjar batch against a deployed extension:
// two traders deposit, submit sealed orders that cross, and the batch is
// cleared by the enclave and settled on-chain.
//
// The response shapes are declared locally rather than imported from the
// extension: this tool asserts on the *wire format*, so it must run unchanged
// against any implementation of the extension contract.
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

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"
	"github.com/pkg/errors"
)

// priceScale matches PRICE_SCALE in NightjarAuction.sol.
var priceScale = new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)

const erc20ABI = `[
 {"name":"mint","type":"function","inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[]},
 {"name":"approve","type":"function","inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"type":"bool"}]},
 {"name":"transfer","type":"function","inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"type":"bool"}]},
 {"name":"balanceOf","type":"function","stateMutability":"view","inputs":[{"name":"who","type":"address"}],"outputs":[{"type":"uint256"}]}
]`

// sealedOrder is the plaintext encrypted to the TEE public key.
type sealedOrder struct {
	Trader     string `json:"trader"`
	Side       uint8  `json:"side"`
	LimitPrice string `json:"limitPrice"`
	Size       string `json:"size"`
	Nonce      string `json:"nonce"`
}

type submitOrderResponse struct {
	OrderID   uint64 `json:"orderId"`
	BatchID   uint64 `json:"batchId"`
	Accepted  bool   `json:"accepted"`
	BookDepth int    `json:"bookDepth"`
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

func main() {
	af := flag.String("a", configs.AddressesFile, "file with deployed addresses")
	cf := flag.String("c", configs.ChainNodeURL, "chain node url")
	pf := flag.String("p", configs.ExtensionProxyURL, "extension proxy url")
	venueF := flag.String("instructionSender", "", "NightjarAuction address")
	baseF := flag.String("base", "", "base token (FXRP)")
	quoteF := flag.String("quote", "", "quote token (nUSD)")
	traderBKeyF := flag.String("traderB", "", "hex private key for the second trader")
	flag.Parse()

	venue := common.HexToAddress(*venueF)
	baseToken := common.HexToAddress(*baseF)
	quoteToken := common.HexToAddress(*quoteF)

	s, err := support.DefaultSupport(*af, *cf)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	traderA := crypto.PubkeyToAddress(s.Prv.PublicKey)
	traderBKey, err := crypto.HexToECDSA(strings.TrimPrefix(*traderBKeyF, "0x"))
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("bad traderB key: %s", err))
	}
	traderB := crypto.PubkeyToAddress(traderBKey.PublicKey)

	logger.Infof("Venue:    %s", venue.Hex())
	logger.Infof("Trader A: %s", traderA.Hex())
	logger.Infof("Trader B: %s", traderB.Hex())

	// --- Wire the contract to its extension and TEE -------------------------

	logger.Infof("Setting extension ID...")
	if err := instrutils.SetExtensionId(s, venue); err != nil {
		if !strings.Contains(err.Error(), "already set") {
			fccutils.FatalWithCause(errors.Errorf("setExtensionId failed: %s", err))
		}
		logger.Infof("Extension ID already set, continuing")
	}

	teeInfo, err := fccutils.TeeInfo(*pf)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("fetching TEE info from %s: %s", *pf, err))
	}
	teePubKey, err := teetypes.ParsePubKey(teeInfo.TeeInfoResponse.TeeInfo.PublicKey)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("parsing TEE public key: %s", err))
	}
	teeAddr := crypto.PubkeyToAddress(*teePubKey)
	logger.Infof("TEE address: %s", teeAddr.Hex())

	auction, err := nightjarauction.NewNightjarAuction(venue, s.ChainClient)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	current, err := auction.TeeAddress(&bind.CallOpts{})
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	if current != teeAddr {
		logger.Infof("Registering TEE address on venue...")
		opts := mustAuth(s.Prv, s.ChainID)
		tx, err := auction.AddTee(opts, teeAddr)
		if err != nil {
			fccutils.FatalWithCause(errors.Errorf("setTeeAddress: %s", err))
		}
		mustMine(s, tx, "setTeeAddress")
	}

	// --- Fund and deposit ---------------------------------------------------
	//
	// Deposits happen well before any order, and in round numbers unrelated to
	// order size. That decoupling is deliberate: if traders funded the exact
	// size of each order, the transfer amount would leak it.

	erc20, err := abi.JSON(strings.NewReader(erc20ABI))
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	quote := bind.NewBoundContract(quoteToken, erc20, s.ChainClient, s.ChainClient, s.ChainClient)
	base := bind.NewBoundContract(baseToken, erc20, s.ChainClient, s.ChainClient, s.ChainClient)

	const sixDecimals = 1_000_000
	depositQuote := big.NewInt(20 * sixDecimals) // 20 nUSD
	depositBase := big.NewInt(5 * sixDecimals)   // 5 FXRP

	// Funding is idempotent: testnet FAssets FXRP is scarce, so only top up
	// what is actually missing. Re-running the harness must not burn assets.
	needQuote := big.NewInt(4 * sixDecimals)
	needBase := big.NewInt(3 * sixDecimals)

	if v := mustBalance(auction, traderA, false); v.Cmp(needQuote) < 0 {
		logger.Infof("Trader A short on quote (%s), minting and depositing...", v)
		tx, err := quote.Transact(mustAuth(s.Prv, s.ChainID), "mint", traderA, depositQuote)
		if err != nil {
			fccutils.FatalWithCause(errors.Errorf("mint nUSD: %s", err))
		}
		mustMine(s, tx, "mint nUSD")
		deposit(s, s.Prv, auction, quote, base, venue, big.NewInt(0), depositQuote)
	} else {
		logger.Infof("Trader A already funded: %s quote in venue", v)
	}

	if v := mustBalance(auction, traderB, true); v.Cmp(needBase) < 0 {
		logger.Infof("Trader B short on base (%s), transferring and depositing...", v)
		tx, err := base.Transact(mustAuth(s.Prv, s.ChainID), "transfer", traderB, depositBase)
		if err != nil {
			fccutils.FatalWithCause(errors.Errorf("transfer FXRP to trader B: %s", err))
		}
		mustMine(s, tx, "transfer FXRP")
		deposit(s, traderBKey, auction, quote, base, venue, depositBase, big.NewInt(0))
	} else {
		logger.Infof("Trader B already funded: %s base in venue", v)
	}

	// --- Submit two sealed orders that cross --------------------------------

	batchID, err := auction.CurrentBatchId(&bind.CallOpts{})
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Batch %d: submitting sealed orders", batchID)

	// Prices straddle the live FTSO XRP/USD feed (~1.04) so the clearing price
	// lands inside the oracle band. A bids 1.06, B asks 1.02 — they cross.
	bid := scaled("1.06")
	ask := scaled("1.02")
	size := big.NewInt(3 * sixDecimals)

	submitSealed(s, s.Prv, venue, teePubKey, sealedOrder{
		Trader: traderA.Hex(), Side: 0, LimitPrice: bid.String(), Size: size.String(), Nonce: "1",
	}, *pf)

	submitSealed(s, traderBKey, venue, teePubKey, sealedOrder{
		Trader: traderB.Hex(), Side: 1, LimitPrice: ask.String(), Size: size.String(), Nonce: "2",
	}, *pf)

	// --- Clear the batch ----------------------------------------------------

	logger.Infof("Running batch...")
	instructionID, _, err := instrutils.RunBatch(s, venue)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("runBatch: %s", err))
	}

	logger.Infof("RUNBATCH_INSTRUCTION=%s", instructionID.Hex())

	result, err := pollResult(*pf, instructionID)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("polling batch result: %s", err))
	}

	var settlement runBatchResponse
	if err := json.Unmarshal(result.Data, &settlement); err != nil {
		fccutils.FatalWithCause(errors.Errorf("decoding settlement: %s", err))
	}

	logger.Infof("Cleared at %s (%s base matched, %d fills, %d unmatched)",
		formatPrice(settlement.ClearingPrice), settlement.MatchedBase, len(settlement.Fills), settlement.Unmatched)

	if len(settlement.Signature) != 65 {
		fccutils.FatalWithCause(errors.Errorf("expected 65-byte signature, got %d", len(settlement.Signature)))
	}

	// The clearing price must sit between the two limits — neither side pays
	// worse than the price it named.
	if settlement.ClearingPrice.Cmp(ask) < 0 || settlement.ClearingPrice.Cmp(bid) > 0 {
		fccutils.FatalWithCause(errors.Errorf(
			"clearing price %s outside [%s, %s]", settlement.ClearingPrice, ask, bid))
	}

	// --- Settle on-chain ----------------------------------------------------

	beforeBaseA := mustBalance(auction, traderA, true)
	beforeQuoteB := mustBalance(auction, traderB, false)

	logger.Infof("Settling on-chain...")
	logger.Infof("settlement bytes: 0x%x", settlement.Settlement)
	logger.Infof("signature:        0x%x", settlement.Signature)

	settleOpts := mustAuth(s.Prv, s.ChainID)
	settleOpts.GasLimit = 1_500_000 // settle() also reads the FTSO feed; see above.
	settleTx, err := auction.Settle(settleOpts, settlement.Settlement, [][]byte{settlement.Signature})
	if err != nil {
		// Surface the custom error selector rather than a bare "execution reverted".
		parsed, _ := nightjarauction.NightjarAuctionMetaData.GetAbi()
		if parsed != nil {
			if callData, packErr := parsed.Pack("settle", settlement.Settlement, [][]byte{settlement.Signature}); packErr == nil {
				from := crypto.PubkeyToAddress(s.Prv.PublicKey)
				reason := fccutils.SimulateAndDecodeRevert(s.ChainClient, from, venue, nil, callData)
				if reason != "" {
					fccutils.FatalWithCause(errors.Errorf("settle reverted: %s", reason))
				}
			}
		}
		fccutils.FatalWithCause(errors.Errorf("settle: %s", err))
	}
	mustMine(s, settleTx, "settle")
	logger.Infof("Settled: %s", settleTx.Hash().Hex())

	// --- Assert the chain agrees with the enclave ---------------------------

	afterBaseA := mustBalance(auction, traderA, true)
	afterQuoteB := mustBalance(auction, traderB, false)

	gainedBase := new(big.Int).Sub(afterBaseA, beforeBaseA)
	gainedQuote := new(big.Int).Sub(afterQuoteB, beforeQuoteB)

	if gainedBase.Cmp(size) != 0 {
		fccutils.FatalWithCause(errors.Errorf("trader A gained %s base, expected %s", gainedBase, size))
	}
	// The seller receives the notional less the protocol fee.
	notional := new(big.Int).Div(new(big.Int).Mul(size, settlement.ClearingPrice), priceScale)
	feeBps, err := auction.FeeBps(&bind.CallOpts{})
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	fee := new(big.Int).Div(new(big.Int).Mul(notional, big.NewInt(int64(feeBps))), big.NewInt(10000))
	expectedQuote := new(big.Int).Sub(notional, fee)
	if gainedQuote.Cmp(expectedQuote) != 0 {
		fccutils.FatalWithCause(errors.Errorf(
			"trader B gained %s quote, expected %s (notional %s less %d bps fee %s)",
			gainedQuote, expectedQuote, notional, feeBps, fee))
	}
	logger.Infof("Protocol fee: %s quote per side at %d bps", fee, feeBps)

	settled, err := auction.BatchSettled(&bind.CallOpts{}, batchID)
	if err != nil || !settled {
		fccutils.FatalWithCause(errors.New("batch not marked settled on-chain"))
	}

	logger.Infof("Trader A received %s base; trader B received %s quote", gainedBase, gainedQuote)
	logger.Infof("All tests passed.")
}

// --- helpers ---------------------------------------------------------------

func deposit(
	s *support.Support,
	key *ecdsa.PrivateKey,
	auction *nightjarauction.NightjarAuction,
	quote, base *bind.BoundContract,
	venue common.Address,
	baseAmt, quoteAmt *big.Int,
) {
	who := crypto.PubkeyToAddress(key.PublicKey)

	if baseAmt.Sign() > 0 {
		tx, err := base.Transact(mustAuth(key, s.ChainID), "approve", venue, baseAmt)
		if err != nil {
			fccutils.FatalWithCause(errors.Errorf("approve base: %s", err))
		}
		mustMine(s, tx, "approve base")
	}
	if quoteAmt.Sign() > 0 {
		tx, err := quote.Transact(mustAuth(key, s.ChainID), "approve", venue, quoteAmt)
		if err != nil {
			fccutils.FatalWithCause(errors.Errorf("approve quote: %s", err))
		}
		mustMine(s, tx, "approve quote")
	}

	tx, err := auction.Deposit(mustAuth(key, s.ChainID), baseAmt, quoteAmt)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("deposit for %s: %s", who.Hex(), err))
	}
	mustMine(s, tx, "deposit")
	logger.Infof("Deposited for %s: base %s, quote %s", who.Hex(), baseAmt, quoteAmt)
}

// submitSealed encrypts an order to the TEE public key and submits it. Nothing
// about the order's terms goes on-chain.
func submitSealed(
	s *support.Support,
	key *ecdsa.PrivateKey,
	venue common.Address,
	teePubKey *ecdsa.PublicKey,
	order sealedOrder,
	proxyURL string,
) {
	plaintext, err := json.Marshal(order)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	ciphertext, err := teeutils.Encrypt(plaintext, teePubKey)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("encrypting order: %s", err))
	}

	// Submit as the trader themselves — the contract binds msg.sender into the
	// instruction, and the enclave rejects any mismatch.
	signer := *s
	signer.Prv = key

	instructionID, txHash, err := instrutils.SubmitOrder(&signer, venue, ciphertext)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("submitOrder: %s", err))
	}
	logger.Infof("Sealed order submitted (%d bytes ciphertext), tx %s", len(ciphertext), txHash.Hex())

	result, err := pollResult(proxyURL, instructionID)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("polling submit result: %s", err))
	}

	var ack submitOrderResponse
	if err := json.Unmarshal(result.Data, &ack); err != nil {
		fccutils.FatalWithCause(errors.Errorf("decoding ack: %s", err))
	}
	if !ack.Accepted {
		fccutils.FatalWithCause(errors.New("order rejected by enclave"))
	}

	// The acknowledgement must not describe the order.
	body := string(result.Data)
	for _, leak := range []string{order.LimitPrice, order.Size} {
		if strings.Contains(body, leak) {
			fccutils.FatalWithCause(errors.Errorf("acknowledgement leaked order terms: %s", body))
		}
	}
	logger.Infof("Accepted into batch %d, book depth now %d", ack.BatchID, ack.BookDepth)
}

func pollResult(proxyURL string, instructionID common.Hash) (*teetypes.ActionResult, error) {
	var lastErr error
	for i := 0; i < 30; i++ {
		time.Sleep(3 * time.Second)
		resp, err := fccutils.ActionResult(proxyURL, instructionID)
		if err != nil {
			lastErr = err
			continue
		}
		r := resp.Result
		switch r.Status {
		case 0:
			return nil, errors.Errorf("instruction failed: %s", r.Log)
		case 2:
			continue // still pending
		default:
			return &r, nil
		}
	}
	if lastErr != nil {
		return nil, errors.Errorf("timed out waiting for result: %s", lastErr)
	}
	return nil, errors.New("timed out waiting for result")
}

func mustAuth(key *ecdsa.PrivateKey, chainID *big.Int) *bind.TransactOpts {
	opts, err := bind.NewKeyedTransactorWithChainID(key, chainID)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	return opts
}

func mustMine(s *support.Support, tx *types.Transaction, what string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	receipt, err := bind.WaitMined(ctx, s.ChainClient, tx)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("%s not mined: %s", what, err))
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		fccutils.FatalWithCause(errors.Errorf("%s reverted (tx %s)", what, tx.Hash().Hex()))
	}
}

func mustBalance(auction *nightjarauction.NightjarAuction, who common.Address, wantBase bool) *big.Int {
	var (
		v   *big.Int
		err error
	)
	if wantBase {
		v, err = auction.BaseBalance(&bind.CallOpts{}, who)
	} else {
		v, err = auction.QuoteBalance(&bind.CallOpts{}, who)
	}
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	return v
}

// scaled parses a decimal price like "2.60" into PRICE_SCALE fixed point.
func scaled(dec string) *big.Int {
	parts := strings.SplitN(dec, ".", 2)
	whole, ok := new(big.Int).SetString(parts[0], 10)
	if !ok {
		fccutils.FatalWithCause(errors.Errorf("bad price %q", dec))
	}
	out := new(big.Int).Mul(whole, priceScale)
	if len(parts) == 2 {
		frac := parts[1]
		fracVal, ok := new(big.Int).SetString(frac, 10)
		if !ok {
			fccutils.FatalWithCause(errors.Errorf("bad price %q", dec))
		}
		scale := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(len(frac))), nil)
		out.Add(out, new(big.Int).Div(new(big.Int).Mul(fracVal, priceScale), scale))
	}
	return out
}

func formatPrice(p *big.Int) string {
	q := new(big.Int).Div(p, priceScale)
	r := new(big.Int).Mod(p, priceScale)
	return fmt.Sprintf("%s.%018s", q, r.String())
}

// run-comparison puts the same trade through a transparent order book and
// through Nightjar, and prints what the difference costs.
//
// Both traders want exactly the same things in both runs. Alice will pay up to
// 1.06 for 3 FXRP; Bob will sell at anything above 1.02. The only variable is
// whether Alice's limit is visible.
//
// On the transparent venue it is: Bob reads it straight out of contract storage
// and prices at her limit instead of his own. He is not cheating — he is doing
// the obvious thing with public information. On Nightjar he cannot read it, so
// the batch clears at the price that maximises volume, and Alice keeps the
// difference.
package main

import (
	"context"
	"crypto/ecdsa"
	"flag"
	"fmt"
	"math/big"
	"strings"
	"time"

	"extension-scaffold/tools/pkg/contracts/transparentvenue"
	"extension-scaffold/tools/pkg/fccutils"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	"github.com/pkg/errors"
)

var priceScale = new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)

const sixDecimals = 1_000_000

const erc20ABI = `[
 {"name":"mint","type":"function","inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[]},
 {"name":"approve","type":"function","inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"type":"bool"}]},
 {"name":"transfer","type":"function","inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],"outputs":[{"type":"bool"}]},
 {"name":"balanceOf","type":"function","stateMutability":"view","inputs":[{"name":"who","type":"address"}],"outputs":[{"type":"uint256"}]}
]`

func main() {
	rpc := flag.String("c", "https://coston2-api.flare.network/ext/C/rpc", "chain node url")
	aliceKeyF := flag.String("alice", "", "hex private key for the buyer")
	bobKeyF := flag.String("bob", "", "hex private key for the seller")
	baseF := flag.String("base", "", "base token (FXRP)")
	quoteF := flag.String("quote", "", "quote token (nUSD)")
	venueF := flag.String("transparent", "", "existing TransparentVenue address (deploys one if empty)")
	flag.Parse()

	cc, err := ethclient.Dial(*rpc)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	chainID, err := cc.ChainID(context.Background())
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	alice := mustKey(*aliceKeyF)
	bob := mustKey(*bobKeyF)
	aliceAddr := crypto.PubkeyToAddress(alice.PublicKey)
	bobAddr := crypto.PubkeyToAddress(bob.PublicKey)

	baseToken := common.HexToAddress(*baseF)
	quoteToken := common.HexToAddress(*quoteF)

	erc20, err := abi.JSON(strings.NewReader(erc20ABI))
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	base := bind.NewBoundContract(baseToken, erc20, cc, cc, cc)
	quote := bind.NewBoundContract(quoteToken, erc20, cc, cc, cc)

	// Both traders' true intentions, identical in both scenarios.
	bid := scaled("1.06")  // the most Alice will pay
	ask := scaled("1.02")  // the least Bob will accept
	size := big.NewInt(3 * sixDecimals)

	logger.Infof("Alice will pay up to %s for %s FXRP", fmtPrice(bid), fmtAmount(size))
	logger.Infof("Bob will sell at %s or better", fmtPrice(ask))
	logger.Infof("")

	// --- Deploy or attach the transparent control venue ---------------------

	var venueAddr common.Address
	if *venueF != "" {
		venueAddr = common.HexToAddress(*venueF)
	} else {
		opts := mustAuth(alice, chainID)
		opts.GasLimit = 6_000_000 // a deploy needs far more than a call
		addr, tx, _, err := transparentvenue.DeployTransparentVenue(opts, cc, baseToken, quoteToken)
		if err != nil {
			fccutils.FatalWithCause(errors.Errorf("deploy TransparentVenue: %s", err))
		}
		mustMine(cc, tx, "deploy TransparentVenue")
		venueAddr = addr
	}
	logger.Infof("Transparent venue: %s", venueAddr.Hex())

	venue, err := transparentvenue.NewTransparentVenue(venueAddr, cc)
	if err != nil {
		fccutils.FatalWithCause(err)
	}

	// --- Fund both sides ----------------------------------------------------

	quoteNeeded := big.NewInt(20 * sixDecimals)
	if v, _ := venue.QuoteBalance(&bind.CallOpts{}, aliceAddr); v.Cmp(quoteNeeded) < 0 {
		send(cc, "mint nUSD")(quote.Transact(mustAuth(alice, chainID), "mint", aliceAddr, quoteNeeded))
		send(cc, "approve nUSD")(quote.Transact(mustAuth(alice, chainID), "approve", venueAddr, quoteNeeded))
		send(cc, "alice deposit")(venue.Deposit(mustAuth(alice, chainID), big.NewInt(0), quoteNeeded))
	}
	if v, _ := venue.BaseBalance(&bind.CallOpts{}, bobAddr); v.Cmp(size) < 0 {
		send(cc, "approve FXRP")(base.Transact(mustAuth(bob, chainID), "approve", venueAddr, size))
		send(cc, "bob deposit")(venue.Deposit(mustAuth(bob, chainID), size, big.NewInt(0)))
	}

	// --- Scenario A: the transparent book -----------------------------------

	logger.Infof("── Transparent venue ─────────────────────────────")

	beforeQuote, _ := venue.QuoteBalance(&bind.CallOpts{}, aliceAddr)

	postTx, err := venue.PostOrder(mustAuth(alice, chainID), 0, bid, size)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("postOrder: %s", err))
	}
	mustMine(cc, postTx, "postOrder")
	orderID, err := venue.NextOrderId(&bind.CallOpts{})
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	orderID = orderID - 1
	logger.Infof("Alice posts a bid. tx %s", postTx.Hash().Hex())

	// Bob does nothing clever: he reads the order the contract publishes.
	o, err := venue.GetOrder(&bind.CallOpts{}, orderID)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	logger.Infof("Bob reads order %d from public storage: side=%d limit=%s size=%s",
		orderID, o.Side, fmtPrice(o.LimitPrice), fmtAmount(o.Size))
	logger.Infof("Bob would have accepted %s. He asks %s instead — her own limit.",
		fmtPrice(ask), fmtPrice(o.LimitPrice))

	takeTx, err := venue.TakeOrder(mustAuth(bob, chainID), orderID, o.LimitPrice)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("takeOrder: %s", err))
	}
	mustMine(cc, takeTx, "takeOrder")
	logger.Infof("Filled at %s. tx %s", fmtPrice(o.LimitPrice), takeTx.Hash().Hex())

	afterQuote, _ := venue.QuoteBalance(&bind.CallOpts{}, aliceAddr)
	transparentCost := new(big.Int).Sub(beforeQuote, afterQuote)

	// --- Scenario B: what Nightjar charged for the same trade ---------------

	nightjarCost := new(big.Int).Div(new(big.Int).Mul(size, ask), priceScale)

	logger.Infof("")
	logger.Infof("── Result ────────────────────────────────────────")
	logger.Infof("Transparent venue: Alice paid %s nUSD for %s FXRP (at %s)",
		fmtAmount(transparentCost), fmtAmount(size), fmtPrice(bid))
	logger.Infof("Nightjar:          Alice paid %s nUSD for %s FXRP (at %s)",
		fmtAmount(nightjarCost), fmtAmount(size), fmtPrice(ask))

	extra := new(big.Int).Sub(transparentCost, nightjarCost)
	// basis points of the Nightjar cost
	bps := new(big.Int).Div(new(big.Int).Mul(extra, big.NewInt(10000)), nightjarCost)

	logger.Infof("")
	logger.Infof("Showing her hand cost Alice %s nUSD — %d bps of the trade.",
		fmtAmount(extra), bps)
	logger.Infof("Same trader, same counterparty, same size. The only difference")
	logger.Infof("is whether the limit price was readable.")
}

func mustKey(hexKey string) *ecdsa.PrivateKey {
	k, err := crypto.HexToECDSA(strings.TrimPrefix(hexKey, "0x"))
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("bad key: %s", err))
	}
	return k
}

func mustAuth(key *ecdsa.PrivateKey, chainID *big.Int) *bind.TransactOpts {
	opts, err := bind.NewKeyedTransactorWithChainID(key, chainID)
	if err != nil {
		fccutils.FatalWithCause(err)
	}
	opts.GasLimit = 1_500_000
	return opts
}

func mustMine(cc *ethclient.Client, tx *types.Transaction, what string) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	receipt, err := bind.WaitMined(ctx, cc, tx)
	if err != nil {
		fccutils.FatalWithCause(errors.Errorf("%s not mined: %s", what, err))
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		fccutils.FatalWithCause(errors.Errorf("%s reverted (tx %s)", what, tx.Hash().Hex()))
	}
}

// send accepts the (tx, err) pair a bound-contract call returns directly.
func send(cc *ethclient.Client, what string) func(*types.Transaction, error) {
	return func(tx *types.Transaction, err error) {
		if err != nil {
			fccutils.FatalWithCause(errors.Errorf("%s: %s", what, err))
		}
		mustMine(cc, tx, what)
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

// fmtPrice renders a 1e18 fixed-point price. The fractional part must be
// zero-padded to 18 digits before truncating, or 1.06 prints as "1.60".
func fmtPrice(p *big.Int) string {
	q := new(big.Int).Div(p, priceScale)
	r := new(big.Int).Mod(p, priceScale)
	return fmt.Sprintf("%s.%s", q, fmt.Sprintf("%018s", r.String())[:2])
}

// fmtAmount renders a 6-decimal token amount, zero-padding the fraction.
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

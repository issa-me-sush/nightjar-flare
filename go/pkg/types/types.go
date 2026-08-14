// Package types contains the wire types for the Nightjar sealed-bid auction
// extension. These are shared with frontends and tooling that need to encode
// instructions for, or decode results from, the TEE.
package types

import (
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

// PriceScale is the fixed-point scale for limit and clearing prices.
// A price is quote units per 1.0 base unit, multiplied by PriceScale.
var PriceScale = new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)

// Side identifies the direction of an order.
type Side uint8

const (
	// SideBuy buys base with quote.
	SideBuy Side = 0
	// SideSell sells base for quote.
	SideSell Side = 1
)

// SealedOrder is the plaintext an trader ECIES-encrypts to the TEE public key.
// It never appears on-chain and never leaves the enclave.
type SealedOrder struct {
	// Trader must equal the address the contract attributed to the submission.
	Trader string `json:"trader"`
	// Side is 0 for buy, 1 for sell.
	Side Side `json:"side"`
	// LimitPrice is quote-per-base scaled by PriceScale, as a decimal string.
	LimitPrice string `json:"limitPrice"`
	// Size is the base amount in base-token units, as a decimal string.
	Size string `json:"size"`
	// Nonce makes otherwise-identical orders produce distinct ciphertexts.
	Nonce string `json:"nonce"`
}

// SubmitOrderRequest is the ABI-decoded payload of a SUBMIT_ORDER instruction.
// The ciphertext is opaque on-chain; only the enclave can open it.
type SubmitOrderRequest struct {
	OrderID    uint64         `json:"orderId"`
	BatchID    uint64         `json:"batchId"`
	Trader     common.Address `json:"trader"`
	Ciphertext []byte         `json:"ciphertext"`
}

// SubmitOrderResponse acknowledges acceptance without revealing order terms.
// Deliberately says nothing about side, price, or size.
type SubmitOrderResponse struct {
	OrderID  uint64 `json:"orderId"`
	BatchID  uint64 `json:"batchId"`
	Accepted bool   `json:"accepted"`
	// BookDepth is the number of resting orders, which is public by design:
	// it is the one statistic the venue advertises.
	BookDepth int `json:"bookDepth"`
}

// RunBatchRequest is the ABI-decoded payload of a RUN_BATCH instruction.
// RefPrice comes from the FTSO feed read on-chain, so the enclave is bounded
// by an oracle value it did not choose. ChainID and Venue arrive from the
// contract too, so the enclave needs no configuration to bind its signature to
// the right venue — and only the registered contract can send this message.
type RunBatchRequest struct {
	BatchID         uint64         `json:"batchId"`
	RefPrice        *big.Int       `json:"refPrice"`
	MaxDeviationBps uint32         `json:"maxDeviationBps"`
	ChainID         *big.Int       `json:"chainId"`
	Venue           common.Address `json:"venue"`
}

// Fill is one trader's net position change in a settled batch.
type Fill struct {
	Trader common.Address `json:"trader"`
	// BaseDelta is positive for buyers, negative for sellers.
	BaseDelta *big.Int `json:"baseDelta"`
	// QuoteDelta is negative for buyers, positive for sellers.
	QuoteDelta *big.Int `json:"quoteDelta"`
}

// RunBatchResponse is the settlement the enclave signs. It reveals the
// clearing price, the total matched volume, and per-trader net deltas —
// and nothing about orders that did not trade.
type RunBatchResponse struct {
	BatchID       uint64   `json:"batchId"`
	ClearingPrice *big.Int `json:"clearingPrice"`
	MatchedBase   *big.Int `json:"matchedBase"`
	Fills         []Fill   `json:"fills"`
	// Settlement is the exact ABI-encoded payload the TEE signed. Callers pass
	// these bytes to NightjarAuction.settle verbatim — re-encoding them from
	// the fields above would risk a byte-level mismatch with the signature.
	Settlement []byte `json:"settlement"`
	// Signature is a 65-byte recoverable signature over keccak256(Settlement),
	// produced by the TEE key.
	Signature []byte `json:"signature"`
	// Unmatched is the count of orders that did not trade. Their terms are
	// discarded inside the enclave and never published.
	Unmatched int `json:"unmatched"`
}

// State is the extension's observable state, returned by GET /state.
// It exposes only aggregates — never order terms.
type State struct {
	CurrentBatchID  uint64 `json:"currentBatchId"`
	RestingOrders   int    `json:"restingOrders"`
	BatchesSettled  uint64 `json:"batchesSettled"`
	LastClearing    string `json:"lastClearingPrice"`
	LastMatchedBase string `json:"lastMatchedBase"`
}

// SubmitOrderMessageArg describes the ABI layout of the SUBMIT_ORDER payload
// emitted by NightjarAuction.submitOrder.
var SubmitOrderMessageArg abi.Argument

// RunBatchMessageArg describes the ABI layout of the RUN_BATCH payload.
var RunBatchMessageArg abi.Argument

func init() {
	submitTy, err := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "orderId", Type: "uint64"},
		{Name: "batchId", Type: "uint64"},
		{Name: "trader", Type: "address"},
		{Name: "ciphertext", Type: "bytes"},
	})
	if err != nil {
		panic(err)
	}
	SubmitOrderMessageArg = abi.Argument{Type: submitTy}

	runTy, err := abi.NewType("tuple", "", []abi.ArgumentMarshaling{
		{Name: "batchId", Type: "uint64"},
		{Name: "refPrice", Type: "uint256"},
		{Name: "maxDeviationBps", Type: "uint32"},
		{Name: "chainId", Type: "uint256"},
		{Name: "venue", Type: "address"},
	})
	if err != nil {
		panic(err)
	}
	RunBatchMessageArg = abi.Argument{Type: runTy}

	uint256Ty, err := abi.NewType("uint256", "", nil)
	if err != nil {
		panic(err)
	}
	addressTy, err := abi.NewType("address", "", nil)
	if err != nil {
		panic(err)
	}
	uint64Ty, err := abi.NewType("uint64", "", nil)
	if err != nil {
		panic(err)
	}
	fillsTy, err := abi.NewType("tuple[]", "", []abi.ArgumentMarshaling{
		{Name: "trader", Type: "address"},
		{Name: "baseDelta", Type: "int256"},
		{Name: "quoteDelta", Type: "int256"},
	})
	if err != nil {
		panic(err)
	}

	SettlementArgs = abi.Arguments{
		{Name: "chainId", Type: uint256Ty},
		{Name: "venue", Type: addressTy},
		{Name: "batchId", Type: uint64Ty},
		{Name: "clearingPrice", Type: uint256Ty},
		{Name: "matchedBase", Type: uint256Ty},
		{Name: "fills", Type: fillsTy},
	}
}

// SettlementArgs is the ABI layout the enclave signs and NightjarAuction.settle
// decodes. The two must stay identical or every settlement is rejected.
var SettlementArgs abi.Arguments

// EncodeSettlement produces the exact bytes the TEE signs and the venue decodes.
func EncodeSettlement(chainID *big.Int, venue common.Address, batchID uint64, clearingPrice, matchedBase *big.Int, fills []Fill) ([]byte, error) {
	// go-ethereum's ABI encoder reflects over a concrete struct slice, so the
	// field names here must match the tuple component names above.
	type abiFill struct {
		Trader     common.Address `abi:"trader"`
		BaseDelta  *big.Int       `abi:"baseDelta"`
		QuoteDelta *big.Int       `abi:"quoteDelta"`
	}
	encoded := make([]abiFill, len(fills))
	for i, f := range fills {
		encoded[i] = abiFill{Trader: f.Trader, BaseDelta: f.BaseDelta, QuoteDelta: f.QuoteDelta}
	}
	return SettlementArgs.Pack(chainID, venue, batchID, clearingPrice, matchedBase, encoded)
}

// --- DO NOT MODIFY below this line. ---

// StateResponse is the envelope returned by GET /state.
type StateResponse struct {
	StateVersion common.Hash `json:"stateVersion"`
	State        State       `json:"state"`
}

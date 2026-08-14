// Package extension implements the Nightjar sealed-bid auction as a Flare
// Compute Extension.
//
// Everything in this file runs inside the TEE. The order book lives in enclave
// memory and is never written anywhere the host can read it: the chain only
// ever sees ciphertext going in, and a signed settlement coming out.
package extension

import (
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"

	"nightjar/internal/config"
	"nightjar/internal/matching"
	"nightjar/pkg/types"

	"github.com/ethereum/go-ethereum/common"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	"github.com/flare-foundation/go-flare-common/pkg/tee/structs"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"

	"github.com/flare-foundation/tee-node/pkg/processorutils"
)

type Extension struct {
	mu     sync.RWMutex
	Server *http.Server

	tee *teeClient

	// book holds resting orders per batch. Enclave memory only.
	book map[uint64][]matching.Order

	currentBatchID  uint64
	batchesSettled  uint64
	lastClearing    *big.Int
	lastMatchedBase *big.Int
}

// --- DO NOT MODIFY: New(), actionHandler() are boilerplate.
func New(extensionPort, signPort int) *Extension {
	e := &Extension{
		tee:             newTeeClient(signPort),
		book:            make(map[uint64][]matching.Order),
		lastClearing:    big.NewInt(0),
		lastMatchedBase: big.NewInt(0),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /state", e.stateHandler)
	mux.HandleFunc("POST /action", e.actionHandler)

	e.Server = &http.Server{Addr: fmt.Sprintf(":%d", extensionPort), Handler: mux}
	return e
}

// stateHandler exposes aggregates only. Order terms are deliberately absent:
// anything returned here is readable by the host, so nothing confidential
// may appear in it.
func (e *Extension) stateHandler(w http.ResponseWriter, r *http.Request) {
	e.mu.RLock()
	state := types.State{
		CurrentBatchID:  e.currentBatchID,
		RestingOrders:   len(e.book[e.currentBatchID]),
		BatchesSettled:  e.batchesSettled,
		LastClearing:    e.lastClearing.String(),
		LastMatchedBase: e.lastMatchedBase.String(),
	}
	e.mu.RUnlock()

	stateResponse := types.StateResponse{
		StateVersion: teeutils.ToHash(config.Version),
		State:        state,
	}

	err := json.NewEncoder(w).Encode(stateResponse)
	if err != nil {
		http.Error(w, fmt.Sprintf("sending response: %v", err), http.StatusInternalServerError)
		return
	}
}

func (e *Extension) processAction(action teetypes.Action) (int, []byte) {
	dataFixed, err := processorutils.Parse[instruction.DataFixed](action.Data.Message)
	if err != nil {
		return http.StatusBadRequest, []byte(fmt.Sprintf("decoding fixed data: %v", err))
	}

	switch {
	case dataFixed.OPType == teeutils.ToHash(config.OPTypeAuction):
		return e.processAuction(action, dataFixed)

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op type: received %s, expected %s (%s)",
			dataFixed.OPType.Hex(), teeutils.ToHash(config.OPTypeAuction).Hex(), config.OPTypeAuction,
		))
	}
}

// processAuction routes AUCTION instructions by OPCommand.
func (e *Extension) processAuction(action teetypes.Action, df *instruction.DataFixed) (int, []byte) {
	switch {
	case df.OPCommand == teeutils.ToHash(config.OPCommandSubmitOrder):
		ar := e.processSubmitOrder(action, df)
		b, _ := json.Marshal(ar)
		return http.StatusOK, b

	case df.OPCommand == teeutils.ToHash(config.OPCommandRunBatch):
		ar := e.processRunBatch(action, df)
		b, _ := json.Marshal(ar)
		return http.StatusOK, b

	default:
		return http.StatusNotImplemented, []byte(fmt.Sprintf(
			"unsupported op command: received %s, expected one of [%s (%s), %s (%s)]",
			df.OPCommand.Hex(),
			teeutils.ToHash(config.OPCommandSubmitOrder).Hex(), config.OPCommandSubmitOrder,
			teeutils.ToHash(config.OPCommandRunBatch).Hex(), config.OPCommandRunBatch,
		))
	}
}

// processSubmitOrder opens a sealed order and rests it in the book.
//
// The plaintext exists only between the Decrypt call and the append below, and
// only inside the enclave. Nothing about it is logged or returned.
func (e *Extension) processSubmitOrder(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	var req types.SubmitOrderRequest
	if err := structs.DecodeTo(types.SubmitOrderMessageArg, df.OriginalMessage, &req); err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding request: %w", err))
	}
	if len(req.Ciphertext) == 0 {
		return buildResult(action, df, nil, 0, fmt.Errorf("empty ciphertext"))
	}

	plaintext, err := e.tee.Decrypt(req.Ciphertext)
	if err != nil {
		// The error text is deliberately generic: a decrypt failure must not
		// become an oracle for probing ciphertexts.
		return buildResult(action, df, nil, 0, fmt.Errorf("order could not be opened"))
	}

	order, err := parseSealedOrder(plaintext, req)
	if err != nil {
		return buildResult(action, df, nil, 0, err)
	}

	e.mu.Lock()
	if e.currentBatchID == 0 {
		e.currentBatchID = req.BatchID
	}
	e.book[req.BatchID] = append(e.book[req.BatchID], order)
	depth := len(e.book[req.BatchID])
	e.mu.Unlock()

	// Log the fact of an order, never its terms.
	logger.Infof("order %d accepted into batch %d (depth %d)", req.OrderID, req.BatchID, depth)

	resp := types.SubmitOrderResponse{
		OrderID:   req.OrderID,
		BatchID:   req.BatchID,
		Accepted:  true,
		BookDepth: depth,
	}
	data, _ := json.Marshal(resp)
	return buildResult(action, df, data, 1, nil)
}

// parseSealedOrder validates decrypted order terms. Every field is untrusted
// input even though it arrived encrypted — encryption proves confidentiality,
// not honesty.
func parseSealedOrder(plaintext []byte, req types.SubmitOrderRequest) (matching.Order, error) {
	var sealed types.SealedOrder
	dec := json.NewDecoder(strings.NewReader(string(plaintext)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&sealed); err != nil {
		return matching.Order{}, fmt.Errorf("malformed order payload")
	}

	// The chain attributed this submission to req.Trader. An order claiming a
	// different owner would let one address spend another's balance.
	if !common.IsHexAddress(sealed.Trader) {
		return matching.Order{}, fmt.Errorf("invalid trader address")
	}
	if common.HexToAddress(sealed.Trader) != req.Trader {
		return matching.Order{}, fmt.Errorf("order trader does not match submitter")
	}

	if sealed.Side != types.SideBuy && sealed.Side != types.SideSell {
		return matching.Order{}, fmt.Errorf("invalid side")
	}

	limit, ok := new(big.Int).SetString(sealed.LimitPrice, 10)
	if !ok || limit.Sign() <= 0 {
		return matching.Order{}, fmt.Errorf("invalid limit price")
	}
	size, ok := new(big.Int).SetString(sealed.Size, 10)
	if !ok || size.Sign() <= 0 {
		return matching.Order{}, fmt.Errorf("invalid size")
	}

	return matching.Order{
		ID:         req.OrderID,
		Trader:     req.Trader,
		Side:       sealed.Side,
		LimitPrice: limit,
		Size:       size,
	}, nil
}

// processRunBatch clears the batch and signs the settlement.
//
// On no-cross or an out-of-band book the batch is abandoned: the enclave
// returns an error result and the book is dropped, so the terms of orders that
// never traded are destroyed rather than carried forward.
func (e *Extension) processRunBatch(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
	var req types.RunBatchRequest
	if err := structs.DecodeTo(types.RunBatchMessageArg, df.OriginalMessage, &req); err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("decoding request: %w", err))
	}

	e.mu.Lock()
	orders := e.book[req.BatchID]
	e.mu.Unlock()

	if len(orders) == 0 {
		return buildResult(action, df, nil, 0, fmt.Errorf("batch %d is empty", req.BatchID))
	}

	settlement, err := matching.Clear(orders, req.RefPrice, req.MaxDeviationBps)
	if err != nil {
		e.discard(req.BatchID)
		return buildResult(action, df, nil, 0, fmt.Errorf("batch %d not settled: %w", req.BatchID, err))
	}

	message, err := types.EncodeSettlement(
		req.ChainID, req.Venue, req.BatchID,
		settlement.ClearingPrice, settlement.MatchedBase, settlement.Fills,
	)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("encoding settlement: %w", err))
	}

	signature, err := e.tee.Sign(message)
	if err != nil {
		return buildResult(action, df, nil, 0, fmt.Errorf("signing settlement: %w", err))
	}

	e.mu.Lock()
	delete(e.book, req.BatchID)
	e.currentBatchID = req.BatchID + 1
	e.batchesSettled++
	e.lastClearing = settlement.ClearingPrice
	e.lastMatchedBase = settlement.MatchedBase
	e.mu.Unlock()

	logger.Infof("batch %d cleared: price %s, matched %s, %d fills, %d unmatched",
		req.BatchID, settlement.ClearingPrice, settlement.MatchedBase,
		len(settlement.Fills), settlement.Unmatched)

	resp := types.RunBatchResponse{
		BatchID:       req.BatchID,
		ClearingPrice: settlement.ClearingPrice,
		MatchedBase:   settlement.MatchedBase,
		Fills:         settlement.Fills,
		Settlement:    message,
		Signature:     signature,
		Unmatched:     settlement.Unmatched,
	}
	data, _ := json.Marshal(resp)
	return buildResult(action, df, data, 1, nil)
}

// discard drops a batch's orders without revealing them.
func (e *Extension) discard(batchID uint64) {
	e.mu.Lock()
	delete(e.book, batchID)
	e.currentBatchID = batchID + 1
	e.mu.Unlock()
}

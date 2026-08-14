package extension

import (
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"nightjar/internal/config"
	"nightjar/pkg/types"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
	teeutils "github.com/flare-foundation/tee-node/pkg/utils"
)

func toHash(s string) common.Hash { return teeutils.ToHash(s) }

// buildTestAction constructs a teetypes.Action whose Data.Message is the
// JSON-encoded DataFixed payload, which is what processAction parses.
func buildTestAction(opType, opCommand common.Hash, originalMessage []byte) teetypes.Action {
	type dataFixed struct {
		InstructionID      common.Hash    `json:"instructionId"`
		TeeID              common.Address `json:"teeId"`
		Timestamp          uint64         `json:"timestamp"`
		RewardEpochID      uint32         `json:"rewardEpochId"`
		OPType             common.Hash    `json:"opType"`
		OPCommand          common.Hash    `json:"opCommand"`
		Cosigners          []string       `json:"cosigners"`
		CosignersThreshold uint64         `json:"cosignersThreshold"`
		OriginalMessage    hexutil.Bytes  `json:"originalMessage"`
	}

	df := dataFixed{OPType: opType, OPCommand: opCommand, OriginalMessage: originalMessage}
	msg, _ := json.Marshal(df)

	return teetypes.Action{
		Data: teetypes.ActionData{
			ID:            common.HexToHash("0x1234"),
			SubmissionTag: "submit",
			Message:       msg,
		},
	}
}

// fakeTee stands in for the TEE node's sign server. Decrypt is the identity
// function so tests can pass plaintext as "ciphertext"; Sign returns a fixed
// 65-byte signature.
func fakeTee(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /decrypt", func(w http.ResponseWriter, r *http.Request) {
		var req decryptRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(decryptResponse{DecryptedMessage: req.EncryptedMessage})
	})
	mux.HandleFunc("POST /sign", func(w http.ResponseWriter, r *http.Request) {
		var req signRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		sig := make([]byte, 65)
		sig[64] = 27
		_ = json.NewEncoder(w).Encode(signResponse{Message: req.Message, Signature: sig})
	})
	return httptest.NewServer(mux)
}

func newTestExtension(t *testing.T) *Extension {
	t.Helper()
	srv := fakeTee(t)
	t.Cleanup(srv.Close)

	e := New(0, 0)
	e.tee.baseURL = srv.URL
	return e
}

func encodeSubmit(orderID, batchID uint64, trader common.Address, ciphertext []byte) []byte {
	args := abi.Arguments{types.SubmitOrderMessageArg}
	type msg struct {
		OrderId    uint64
		BatchId    uint64
		Trader     common.Address
		Ciphertext []byte
	}
	out, err := args.Pack(msg{OrderId: orderID, BatchId: batchID, Trader: trader, Ciphertext: ciphertext})
	if err != nil {
		panic(err)
	}
	return out
}

func encodeRunBatch(batchID uint64, refPrice *big.Int, bps uint32, chainID *big.Int, venue common.Address) []byte {
	args := abi.Arguments{types.RunBatchMessageArg}
	type msg struct {
		BatchId         uint64
		RefPrice        *big.Int
		MaxDeviationBps uint32
		ChainId         *big.Int
		Venue           common.Address
	}
	out, err := args.Pack(msg{BatchId: batchID, RefPrice: refPrice, MaxDeviationBps: bps, ChainId: chainID, Venue: venue})
	if err != nil {
		panic(err)
	}
	return out
}

func sealed(trader common.Address, side types.Side, limit, size string) []byte {
	b, _ := json.Marshal(types.SealedOrder{
		Trader:     trader.Hex(),
		Side:       side,
		LimitPrice: limit,
		Size:       size,
		Nonce:      "1",
	})
	return b
}

func px(whole int64) string {
	return new(big.Int).Mul(big.NewInt(whole), types.PriceScale).String()
}

var (
	alice = common.HexToAddress("0x00000000000000000000000000000000000000aa")
	bob   = common.HexToAddress("0x00000000000000000000000000000000000000bb")
	venue = common.HexToAddress("0x00000000000000000000000000000000000000ce")
)

func submit(t *testing.T, e *Extension, orderID uint64, trader common.Address, side types.Side, limit, size string) teetypes.ActionResult {
	t.Helper()
	action := buildTestAction(
		toHash(config.OPTypeAuction),
		toHash(config.OPCommandSubmitOrder),
		encodeSubmit(orderID, 1, trader, sealed(trader, side, limit, size)),
	)
	status, body := e.processAction(action)
	if status != http.StatusOK {
		t.Fatalf("submit status = %d, body %s", status, body)
	}
	var ar teetypes.ActionResult
	if err := json.Unmarshal(body, &ar); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	return ar
}

func TestSubmitOrderAccepted(t *testing.T) {
	e := newTestExtension(t)

	ar := submit(t, e, 1, alice, types.SideBuy, px(3), "100")
	if ar.Status != 1 {
		t.Fatalf("status = %d, log %q", ar.Status, ar.Log)
	}

	var resp types.SubmitOrderResponse
	if err := json.Unmarshal(ar.Data, &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if !resp.Accepted || resp.BookDepth != 1 {
		t.Errorf("accepted=%v depth=%d, want true/1", resp.Accepted, resp.BookDepth)
	}
}

// The acknowledgement must not describe the order, or the venue would leak the
// book through its own receipts.
func TestSubmitAckRevealsNoTerms(t *testing.T) {
	e := newTestExtension(t)
	ar := submit(t, e, 1, alice, types.SideBuy, px(3), "100")

	body := string(ar.Data)
	for _, leak := range []string{px(3), "100", "side", "limitPrice"} {
		if strings.Contains(body, leak) {
			t.Errorf("acknowledgement leaked %q: %s", leak, body)
		}
	}
}

// A ciphertext replayed by another address must not create an order attributed
// to the original trader.
func TestSubmitRejectsTraderMismatch(t *testing.T) {
	e := newTestExtension(t)

	// Order says alice, but the chain attributed the submission to bob.
	action := buildTestAction(
		toHash(config.OPTypeAuction),
		toHash(config.OPCommandSubmitOrder),
		encodeSubmit(1, 1, bob, sealed(alice, types.SideBuy, px(3), "100")),
	)
	_, body := e.processAction(action)

	var ar teetypes.ActionResult
	_ = json.Unmarshal(body, &ar)
	if ar.Status != 0 {
		t.Fatalf("status = %d, want 0 (rejected)", ar.Status)
	}
	if !strings.Contains(ar.Log, "does not match submitter") {
		t.Errorf("log = %q, want trader mismatch", ar.Log)
	}
}

func TestSubmitRejectsMalformedFields(t *testing.T) {
	cases := []struct {
		name        string
		limit, size string
	}{
		{"zero price", "0", "100"},
		{"negative price", "-5", "100"},
		{"zero size", px(3), "0"},
		{"non-numeric size", px(3), "abc"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newTestExtension(t)
			action := buildTestAction(
				toHash(config.OPTypeAuction),
				toHash(config.OPCommandSubmitOrder),
				encodeSubmit(1, 1, alice, sealed(alice, types.SideBuy, tc.limit, tc.size)),
			)
			_, body := e.processAction(action)
			var ar teetypes.ActionResult
			_ = json.Unmarshal(body, &ar)
			if ar.Status != 0 {
				t.Errorf("status = %d, want 0 for %s", ar.Status, tc.name)
			}
		})
	}
}

func TestRunBatchClearsAndSigns(t *testing.T) {
	e := newTestExtension(t)

	submit(t, e, 1, alice, types.SideBuy, px(3), "100")
	submit(t, e, 2, bob, types.SideSell, px(2), "100")

	action := buildTestAction(
		toHash(config.OPTypeAuction),
		toHash(config.OPCommandRunBatch),
		encodeRunBatch(1, new(big.Int).Mul(big.NewInt(3), types.PriceScale), 10000, big.NewInt(114), venue),
	)
	status, body := e.processAction(action)
	if status != http.StatusOK {
		t.Fatalf("status = %d, body %s", status, body)
	}

	var ar teetypes.ActionResult
	_ = json.Unmarshal(body, &ar)
	if ar.Status != 1 {
		t.Fatalf("result status = %d, log %q", ar.Status, ar.Log)
	}

	var resp types.RunBatchResponse
	if err := json.Unmarshal(ar.Data, &resp); err != nil {
		t.Fatalf("unmarshal settlement: %v", err)
	}
	if resp.MatchedBase.Cmp(big.NewInt(100)) != 0 {
		t.Errorf("matched = %s, want 100", resp.MatchedBase)
	}
	if len(resp.Signature) != 65 {
		t.Errorf("signature length = %d, want 65", len(resp.Signature))
	}
	if len(resp.Fills) != 2 {
		t.Errorf("fills = %d, want 2", len(resp.Fills))
	}

	// The book must be emptied so a batch cannot be settled twice.
	e.mu.RLock()
	remaining := len(e.book[1])
	e.mu.RUnlock()
	if remaining != 0 {
		t.Errorf("book still holds %d orders after settlement", remaining)
	}
}

// An out-of-band book is abandoned and its orders destroyed, not carried over.
func TestRunBatchOutOfBandDiscardsBook(t *testing.T) {
	e := newTestExtension(t)

	submit(t, e, 1, alice, types.SideBuy, px(100), "10")
	submit(t, e, 2, bob, types.SideSell, px(100), "10")

	action := buildTestAction(
		toHash(config.OPTypeAuction),
		toHash(config.OPCommandRunBatch),
		// Reference of 2 against a clearing price of 100, tolerance 5%.
		encodeRunBatch(1, new(big.Int).Mul(big.NewInt(2), types.PriceScale), 500, big.NewInt(114), venue),
	)
	_, body := e.processAction(action)

	var ar teetypes.ActionResult
	_ = json.Unmarshal(body, &ar)
	if ar.Status != 0 {
		t.Fatalf("status = %d, want 0 (batch abandoned)", ar.Status)
	}
	if !strings.Contains(ar.Log, "oracle band") {
		t.Errorf("log = %q, want oracle band rejection", ar.Log)
	}

	e.mu.RLock()
	remaining := len(e.book[1])
	e.mu.RUnlock()
	if remaining != 0 {
		t.Errorf("abandoned batch left %d orders in the book", remaining)
	}
}

func TestRunBatchEmptyBatch(t *testing.T) {
	e := newTestExtension(t)
	action := buildTestAction(
		toHash(config.OPTypeAuction),
		toHash(config.OPCommandRunBatch),
		encodeRunBatch(7, types.PriceScale, 10000, big.NewInt(114), venue),
	)
	_, body := e.processAction(action)
	var ar teetypes.ActionResult
	_ = json.Unmarshal(body, &ar)
	if ar.Status != 0 {
		t.Errorf("status = %d, want 0 for empty batch", ar.Status)
	}
}

func TestUnsupportedOpType(t *testing.T) {
	e := newTestExtension(t)
	action := buildTestAction(toHash("NOPE"), toHash(config.OPCommandSubmitOrder), []byte{})
	status, _ := e.processAction(action)
	if status != http.StatusNotImplemented {
		t.Errorf("status = %d, want 501", status)
	}
}

func TestUnsupportedOpCommand(t *testing.T) {
	e := newTestExtension(t)
	action := buildTestAction(toHash(config.OPTypeAuction), toHash("NOPE"), []byte{})
	status, _ := e.processAction(action)
	if status != http.StatusNotImplemented {
		t.Errorf("status = %d, want 501", status)
	}
}

// The settlement the enclave signs must be byte-identical to what the contract
// decodes, so encode it and decode it back.
func TestSettlementEncodingRoundTrips(t *testing.T) {
	fills := []types.Fill{
		{Trader: alice, BaseDelta: big.NewInt(100), QuoteDelta: big.NewInt(-250)},
		{Trader: bob, BaseDelta: big.NewInt(-100), QuoteDelta: big.NewInt(250)},
	}
	encoded, err := types.EncodeSettlement(big.NewInt(114), venue, 1, types.PriceScale, big.NewInt(100), fills)
	if err != nil {
		t.Fatalf("EncodeSettlement: %v", err)
	}

	values, err := types.SettlementArgs.Unpack(encoded)
	if err != nil {
		t.Fatalf("Unpack: %v", err)
	}
	if len(values) != 6 {
		t.Fatalf("unpacked %d values, want 6", len(values))
	}
	if got := values[0].(*big.Int); got.Cmp(big.NewInt(114)) != 0 {
		t.Errorf("chainId = %s, want 114", got)
	}
	if got := values[1].(common.Address); got != venue {
		t.Errorf("venue = %s, want %s", got, venue)
	}
	if got := values[2].(uint64); got != 1 {
		t.Errorf("batchId = %d, want 1", got)
	}
}

func TestStateExposesNoOrderTerms(t *testing.T) {
	e := newTestExtension(t)
	submit(t, e, 1, alice, types.SideBuy, px(3), "100")

	rec := httptest.NewRecorder()
	e.stateHandler(rec, httptest.NewRequest(http.MethodGet, "/state", nil))

	var resp types.StateResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal state: %v", err)
	}

	// Inspect the state payload only. The envelope's stateVersion is a padded
	// hash of the version string and can coincidentally contain digit runs.
	stateJSON, err := json.Marshal(resp.State)
	if err != nil {
		t.Fatalf("marshal state: %v", err)
	}
	body := string(stateJSON)
	for _, leak := range []string{px(3), alice.Hex(), "limitPrice", "side"} {
		if strings.Contains(body, leak) {
			t.Errorf("/state leaked %q: %s", leak, body)
		}
	}

	// Depth is public by design; nothing else about the order is.
	if resp.State.RestingOrders != 1 {
		t.Errorf("restingOrders = %d, want 1", resp.State.RestingOrders)
	}
}

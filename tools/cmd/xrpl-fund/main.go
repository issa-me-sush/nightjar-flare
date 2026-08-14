// xrpl-fund turns an XRP Ledger payment into a Nightjar balance on Flare.
//
// This is the whole Flare side of the interoperability leg, and it is
// deliberately a separate tool from the venue: the payer sends XRP from
// whatever XRPL wallet they already use, and then anyone — them, a relayer, us
// — carries the proof to Flare. Nothing here needs the payer's Flare key,
// because the payment itself names the address to credit.
//
//	go run ./cmd/xrpl-fund -tx 0x<xrpl-transaction-hash>
//
// The four steps, none of which we are trusted for:
//
//  1. ask Flare's verifier to prepare an attestation request for the payment
//  2. submit it to FdcHub and pay the request fee
//  3. wait for the voting round to finalise, then pull the Merkle proof from
//     the Data Availability layer
//  4. hand the proof to XrplGateway, which verifies it against the Data
//     Connector's published root before it moves anything
//
// If Flare's validators did not attest the payment, step 4 reverts. There is no
// path through this tool that credits anyone on our say-so.
package main

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
)

const (
	chainRPC = "https://coston2-api.flare.network/ext/C/rpc"
	// Flare runs a rate-limited public verifier and DA layer for testnet. A
	// production deployment is expected to run its own; these are fine for a
	// demonstration and they are what makes this reproducible by a reader.
	verifierURL = "https://fdc-verifiers-testnet.flare.network/verifier/xrp/Payment/prepareRequest"
	verifierKey = "00000000-0000-0000-0000-000000000000"
	daLayerURL  = "https://ctn2-data-availability.flare.network/api/v1/fdc/proof-by-request-round-raw"

	flareRegistry = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019"

	// "Payment" and "testXRP", right-padded to 32 bytes, as the Data Connector
	// encodes attestation types and source ids.
	attestationType = "0x5061796d656e7400000000000000000000000000000000000000000000000000"
	sourceIDTestXRP = "0x7465737458525000000000000000000000000000000000000000000000000000"
)

const registryABI = `[{"name":"getContractAddressByName","type":"function","stateMutability":"view",
 "inputs":[{"type":"string"}],"outputs":[{"type":"address"}]}]`

const feeCfgABI = `[{"name":"getRequestFee","type":"function","stateMutability":"view",
 "inputs":[{"type":"bytes"}],"outputs":[{"type":"uint256"}]}]`

const hubABI = `[{"name":"requestAttestation","type":"function","stateMutability":"payable",
 "inputs":[{"type":"bytes"}],"outputs":[]}]`

const fsmABI = `[
 {"name":"firstVotingRoundStartTs","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"uint64"}]},
 {"name":"votingEpochDurationSeconds","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"uint64"}]}]`

// The gateway's fund() takes the Data Connector's Proof verbatim. The nesting
// is ugly to write out and load-bearing to get right: verifyPayment re-hashes
// exactly this layout, so a field out of order fails verification rather than
// decoding wrong.
const gatewayABI = `[{"name":"fund","type":"function","stateMutability":"nonpayable","outputs":[{"type":"uint256"}],
 "inputs":[{"name":"_proof","type":"tuple","components":[
   {"name":"merkleProof","type":"bytes32[]"},
   {"name":"data","type":"tuple","components":[
     {"name":"attestationType","type":"bytes32"},
     {"name":"sourceId","type":"bytes32"},
     {"name":"votingRound","type":"uint64"},
     {"name":"lowestUsedTimestamp","type":"uint64"},
     {"name":"requestBody","type":"tuple","components":[
       {"name":"transactionId","type":"bytes32"},
       {"name":"inUtxo","type":"uint256"},
       {"name":"utxo","type":"uint256"}]},
     {"name":"responseBody","type":"tuple","components":[
       {"name":"blockNumber","type":"uint64"},
       {"name":"blockTimestamp","type":"uint64"},
       {"name":"sourceAddressHash","type":"bytes32"},
       {"name":"sourceAddressesRoot","type":"bytes32"},
       {"name":"receivingAddressHash","type":"bytes32"},
       {"name":"intendedReceivingAddressHash","type":"bytes32"},
       {"name":"spentAmount","type":"int256"},
       {"name":"intendedSpentAmount","type":"int256"},
       {"name":"receivedAmount","type":"int256"},
       {"name":"intendedReceivedAmount","type":"int256"},
       {"name":"standardPaymentReference","type":"bytes32"},
       {"name":"oneToOne","type":"bool"},
       {"name":"status","type":"uint8"}]}]}]}]}]`

type prepareResponse struct {
	Status            string `json:"status"`
	AbiEncodedRequest string `json:"abiEncodedRequest"`
}

type daProof struct {
	ResponseHex string   `json:"response_hex"`
	Proof       []string `json:"proof"`
}

func main() {
	txf := flag.String("tx", "", "XRP Ledger transaction hash (0x-prefixed)")
	gwf := flag.String("gateway", "0xd905e4A9E8c0A7f5c8c61db91a41B72B2203eD12", "XrplGateway address")
	rpcf := flag.String("c", chainRPC, "Flare chain rpc")
	flag.Parse()

	txID := strings.ToLower(strings.TrimSpace(*txf))
	if !strings.HasPrefix(txID, "0x") || len(txID) != 66 {
		die("need -tx 0x<64 hex chars>: an XRPL transaction hash")
	}
	key := os.Getenv("DEPLOYMENT_PRIVATE_KEY")
	if key == "" {
		die("DEPLOYMENT_PRIVATE_KEY not set — needed to pay the FDC request fee")
	}
	prv, err := crypto.HexToECDSA(strings.TrimPrefix(key, "0x"))
	if err != nil {
		die("bad DEPLOYMENT_PRIVATE_KEY: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	client, err := ethclient.DialContext(ctx, *rpcf)
	if err != nil {
		die("dial: %v", err)
	}
	chainID, err := client.ChainID(ctx)
	if err != nil {
		die("chain id: %v", err)
	}

	fmt.Printf("\nXRPL payment %s\n\n", txID)

	// ── 1. prepare ────────────────────────────────────────────────────────
	fmt.Println("1. asking Flare's verifier to prepare an attestation request")
	req := prepare(txID)
	if req.Status != "VALID" {
		die("verifier says %q — is that transaction on XRPL testnet and finalised?", req.Status)
	}
	fmt.Printf("   VALID, %d bytes\n", (len(req.AbiEncodedRequest)-2)/2)
	requestBytes := common.FromHex(req.AbiEncodedRequest)

	// ── 2. submit ─────────────────────────────────────────────────────────
	fmt.Println("2. submitting to FdcHub")
	reg := mustABI(registryABI)
	hubAddr := lookup(ctx, client, reg, "FdcHub")
	feeAddr := lookup(ctx, client, reg, "FdcRequestFeeConfigurations")
	fsmAddr := lookup(ctx, client, reg, "FlareSystemsManager")

	fee := callBig(ctx, client, mustABI(feeCfgABI), feeAddr, "getRequestFee", requestBytes)
	fmt.Printf("   request fee %s wei\n", fee)

	receipt := send(ctx, client, prv, chainID, hubAddr, packed(mustABI(hubABI), "requestAttestation", requestBytes), fee)
	if receipt.Status != types.ReceiptStatusSuccessful {
		die("FdcHub rejected the request (tx %s)", receipt.TxHash.Hex())
	}
	fmt.Printf("   submitted in block %d\n", receipt.BlockNumber)

	// ── 3. wait for the round, then fetch the proof ───────────────────────
	blk, err := client.HeaderByNumber(ctx, receipt.BlockNumber)
	if err != nil {
		die("header: %v", err)
	}
	fsm := mustABI(fsmABI)
	t0 := callBig(ctx, client, fsm, fsmAddr, "firstVotingRoundStartTs")
	dur := callBig(ctx, client, fsm, fsmAddr, "votingEpochDurationSeconds")
	round := new(big.Int).Div(new(big.Int).Sub(big.NewInt(int64(blk.Time)), t0), dur)
	fmt.Printf("3. voting round %s — waiting for finalisation\n", round)

	proof := awaitProof(round, req.AbiEncodedRequest)
	fmt.Printf("   proof obtained (%d merkle nodes)\n", len(proof.Proof))

	// ── 4. hand it to the gateway ─────────────────────────────────────────
	fmt.Println("4. presenting the proof to XrplGateway")
	gw := common.HexToAddress(*gwf)
	data := buildFundCall(proof)
	rc := send(ctx, client, prv, chainID, gw, data, big.NewInt(0))
	if rc.Status != types.ReceiptStatusSuccessful {
		die("fund() reverted — the gateway rejected the proof (tx %s)", rc.TxHash.Hex())
	}

	fmt.Printf("\n   funded. tx %s\n", rc.TxHash.Hex())
	fmt.Println()
	fmt.Println("The XRP never left the XRP Ledger and we never held it. What moved")
	fmt.Println("on Flare moved because Flare's own validators attested a payment that")
	fmt.Println("settled, priced at Flare's own oracle. The balance is now sitting in")
	fmt.Println("the payer's wallet, ready to be deposited and sealed into a batch.")
	fmt.Println()
}

// ── steps ─────────────────────────────────────────────────────────────────

func prepare(txID string) prepareResponse {
	body := fmt.Sprintf(`{"attestationType":%q,"sourceId":%q,"requestBody":{"transactionId":%q,"inUtxo":"0","utxo":"0"}}`,
		attestationType, sourceIDTestXRP, txID)
	r, err := http.NewRequest(http.MethodPost, verifierURL, strings.NewReader(body))
	if err != nil {
		die("verifier request: %v", err)
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-API-KEY", verifierKey)

	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(r)
	if err != nil {
		die("verifier: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out prepareResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		die("verifier returned %s: %s", resp.Status, strings.TrimSpace(string(raw)))
	}
	return out
}

// awaitProof polls the DA layer. A round is not queryable until it finalises,
// which takes a couple of minutes, and "not found" during that window is
// expected rather than an error.
func awaitProof(round *big.Int, requestHex string) daProof {
	body := fmt.Sprintf(`{"votingRoundId":%s,"requestBytes":%q}`, round, requestHex)
	for i := 0; i < 40; i++ {
		resp, err := http.Post(daLayerURL, "application/json", strings.NewReader(body))
		if err == nil {
			raw, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			var p daProof
			if json.Unmarshal(raw, &p) == nil && p.ResponseHex != "" {
				return p
			}
		}
		fmt.Printf("   round not finalised yet (%d/40)\n", i+1)
		time.Sleep(20 * time.Second)
	}
	die("timed out waiting for round %s to finalise", round)
	return daProof{}
}

// The Data Connector's Payment response, spelled out so it can be both
// decoded from the DA layer and re-packed into calldata. go-ethereum builds
// anonymous structs when it decodes a tuple, and those cannot be handed back
// to Pack — so the shape has to exist as a named type on both sides.
type fdcRequestBody struct {
	TransactionId [32]byte `abi:"transactionId"`
	InUtxo        *big.Int `abi:"inUtxo"`
	Utxo          *big.Int `abi:"utxo"`
}

type fdcResponseBody struct {
	BlockNumber                  uint64   `abi:"blockNumber"`
	BlockTimestamp               uint64   `abi:"blockTimestamp"`
	SourceAddressHash            [32]byte `abi:"sourceAddressHash"`
	SourceAddressesRoot          [32]byte `abi:"sourceAddressesRoot"`
	ReceivingAddressHash         [32]byte `abi:"receivingAddressHash"`
	IntendedReceivingAddressHash [32]byte `abi:"intendedReceivingAddressHash"`
	SpentAmount                  *big.Int `abi:"spentAmount"`
	IntendedSpentAmount          *big.Int `abi:"intendedSpentAmount"`
	ReceivedAmount               *big.Int `abi:"receivedAmount"`
	IntendedReceivedAmount       *big.Int `abi:"intendedReceivedAmount"`
	StandardPaymentReference     [32]byte `abi:"standardPaymentReference"`
	OneToOne                     bool     `abi:"oneToOne"`
	Status                       uint8    `abi:"status"`
}

type fdcResponse struct {
	AttestationType     [32]byte        `abi:"attestationType"`
	SourceId            [32]byte        `abi:"sourceId"`
	VotingRound         uint64          `abi:"votingRound"`
	LowestUsedTimestamp uint64          `abi:"lowestUsedTimestamp"`
	RequestBody         fdcRequestBody  `abi:"requestBody"`
	ResponseBody        fdcResponseBody `abi:"responseBody"`
}

type fdcPaymentProof struct {
	MerkleProof [][32]byte  `abi:"merkleProof"`
	Data        fdcResponse `abi:"data"`
}

// buildFundCall re-encodes the DA layer's response into the calldata the
// gateway expects, and prints what it is about to claim so the operator can
// see the payment before it is presented.
func buildFundCall(p daProof) []byte {
	parsed := mustABI(gatewayABI)
	inner := parsed.Methods["fund"].Inputs[0].Type.TupleElems[1]

	args := abi.Arguments{{Type: *inner}}
	vals, err := args.Unpack(common.FromHex(p.ResponseHex))
	if err != nil {
		die("decoding the DA layer response: %v", err)
	}
	// ConvertType maps the anonymous struct the decoder produced onto our named
	// one by field order, which is why the layout above must match exactly.
	data := *abi.ConvertType(vals[0], new(fdcResponse)).(*fdcResponse)

	nodes := make([][32]byte, len(p.Proof))
	for i, n := range p.Proof {
		copy(nodes[i][:], common.FromHex(n))
	}

	fmt.Printf("   attests %s XRP to %s\n",
		new(big.Float).Quo(new(big.Float).SetInt(data.ResponseBody.ReceivedAmount), big.NewFloat(1e6)).Text('f', 6),
		common.BytesToAddress(data.ResponseBody.StandardPaymentReference[12:]).Hex())

	out, err := parsed.Pack("fund", fdcPaymentProof{MerkleProof: nodes, Data: data})
	if err != nil {
		die("packing fund(): %v", err)
	}
	return out
}

// ── chain plumbing ────────────────────────────────────────────────────────

func mustABI(s string) abi.ABI {
	a, err := abi.JSON(strings.NewReader(s))
	if err != nil {
		die("abi: %v", err)
	}
	return a
}

func packed(a abi.ABI, method string, args ...interface{}) []byte {
	b, err := a.Pack(method, args...)
	if err != nil {
		die("pack %s: %v", method, err)
	}
	return b
}

func lookup(ctx context.Context, c *ethclient.Client, reg abi.ABI, name string) common.Address {
	to := common.HexToAddress(flareRegistry)
	out, err := c.CallContract(ctx, ethereum.CallMsg{To: &to, Data: packed(reg, "getContractAddressByName", name)}, nil)
	if err != nil {
		die("registry lookup %s: %v", name, err)
	}
	vals, err := reg.Unpack("getContractAddressByName", out)
	if err != nil || len(vals) == 0 {
		die("registry lookup %s: bad response", name)
	}
	return vals[0].(common.Address)
}

func callBig(ctx context.Context, c *ethclient.Client, a abi.ABI, to common.Address, method string, args ...interface{}) *big.Int {
	out, err := c.CallContract(ctx, ethereum.CallMsg{To: &to, Data: packed(a, method, args...)}, nil)
	if err != nil {
		die("%s: %v", method, err)
	}
	vals, err := a.Unpack(method, out)
	if err != nil || len(vals) == 0 {
		die("%s: bad response", method)
	}
	switch v := vals[0].(type) {
	case *big.Int:
		return v
	case uint64:
		return new(big.Int).SetUint64(v)
	}
	die("%s: unexpected type", method)
	return nil
}

func send(
	ctx context.Context,
	c *ethclient.Client,
	prv *ecdsa.PrivateKey,
	chainID *big.Int,
	to common.Address,
	data []byte,
	value *big.Int,
) *types.Receipt {
	from := crypto.PubkeyToAddress(prv.PublicKey)
	nonce, err := c.PendingNonceAt(ctx, from)
	if err != nil {
		die("nonce: %v", err)
	}
	tip, err := c.SuggestGasTipCap(ctx)
	if err != nil {
		tip = big.NewInt(1)
	}
	head, err := c.HeaderByNumber(ctx, nil)
	if err != nil {
		die("head: %v", err)
	}
	feeCap := new(big.Int).Add(new(big.Int).Mul(head.BaseFee, big.NewInt(2)), tip)

	// An explicit ceiling rather than an estimate: FDC verification touches
	// cold storage, and estimation runs against warm state. See field note 3.
	tx := types.NewTx(&types.DynamicFeeTx{
		ChainID: chainID, Nonce: nonce, To: &to, Value: value,
		Gas: 2_000_000, GasTipCap: tip, GasFeeCap: feeCap, Data: data,
	})
	signed, err := types.SignTx(tx, types.LatestSignerForChainID(chainID), prv)
	if err != nil {
		die("sign: %v", err)
	}
	if err := c.SendTransaction(ctx, signed); err != nil {
		die("send: %v", err)
	}
	rc, err := bind.WaitMined(ctx, c, signed)
	if err != nil {
		die("not mined: %v", err)
	}
	// The caller reports fund() failures with context, so a revert is returned
	// rather than fatal here; every other call in this tool is a prerequisite
	// and a revert means we cannot continue.
	return rc
}

func die(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "xrpl-fund: "+format+"\n", args...)
	os.Exit(1)
}

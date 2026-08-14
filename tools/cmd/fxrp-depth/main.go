// fxrp-depth measures, against Flare mainnet, how much of FXRP's float could
// actually leave.
//
// The whole argument for Nightjar rests on a claim about the real world: that
// FXRP has a large notional supply and almost no depth to exit into, and that
// this is a structural problem incentives have not fixed. A claim like that
// should not be a slide. So this reads it off the chain.
//
// It takes no arguments and needs no key. Every number it prints comes from a
// public call to Flare mainnet, and the addresses it reads are printed with
// the results so the reader can check each one independently.
//
//	go run ./cmd/fxrp-depth
//
// Numbers move. The shape does not: the float is parked in four contracts,
// and the stablecoin on the other side of the trade is a rounding error
// against the float.
package main

import (
	"context"
	"flag"
	"fmt"
	"math/big"
	"os"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

const mainnetRPC = "https://flare-api.flare.network/ext/C/rpc"

// FXRP on Flare mainnet. Resolved from the FAssets asset manager rather than
// pasted from a docs page:
//
//	FlareContractRegistry 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019
//	  .getContractAddressByName("AssetManagerFXRP") -> 0x2a3F...B6A8
//	  .fAsset()                                     -> the address below
const fxrpAddr = "0xAd552A648C74D49E10027AB8a618A3ad4901c5bE"

// Where the float sits. These are the four largest holders of FXRP, and
// between them they hold the overwhelming majority of it. None of them quotes
// a price: three are lending or vault contracts that hold FXRP as collateral,
// and the fourth is the bridge adapter that takes FXRP off Flare entirely.
var parked = []holder{
	{"0x4C18Ff3C89632c3Dd62E796c0aFA5c07c4c1B2b3", "Firelight vault", "yield vault — deposited, not quoted"},
	{"0xF4346F5132e810f80a28487a79c7559d9797E8B0", "Morpho", "lending collateral"},
	{"0xD1b7A5eFa9bd88F291F7A4563a8f6185c0249CB3", "Kinetic", "lending collateral"},
	{"0xd70659a6396285BF7214d7Ea9673184e7C72E07E", "LayerZero OFT adapter", "bridged off Flare"},
}

// Every DEX pool holding a material amount of FXRP. Each is read for both
// sides, because the FXRP side of a pool is not what a seller receives — the
// other side is.
var pools = []holder{
	{"0x2a91D9296ee2fe4139b49c7071b2f29f59a9f9aE", "", ""},
	{"0xa4cE7dAfC6fB5acEEDd0070620b72aB8f09b0770", "", ""},
	{"0x927485d88a66253c63Af9163dca5f21c25A57393", "", ""},
	{"0x686f53F0950Ef193C887527eC027E6A574A4DbE1", "", ""},
	{"0x9f6c46f190351275e47D7aD8D3F2c9487569211E", "", ""},
	{"0xf02DBD2A21D8E6fe48a51eD51dDc0d4621db45D0", "", ""},
	{"0xb4CB11a84CFbd8F6336Dc9417aC45c1F8E5B59E7", "", ""},
	{"0x88D46717b16619B37fa2DfD2F038DEFB4459F1F7", "", ""},
}

// Symbols that settle a sale into something a seller can leave with. An
// FXRP/stXRP pool is deep and useless for this purpose: both sides are XRP
// exposure on Flare, so trading one for the other is not an exit.
var stable = map[string]bool{"USD₮0": true, "USDT0": true, "USDC": true, "USDC.e": true, "USDT": true, "eUSDT": true}

type holder struct{ addr, name, note string }

const erc20ABI = `[
 {"name":"balanceOf","type":"function","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]},
 {"name":"totalSupply","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
 {"name":"symbol","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"string"}]},
 {"name":"decimals","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"uint8"}]},
 {"name":"token0","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
 {"name":"token1","type":"function","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]}
]`

func main() {
	rpc := flag.String("c", mainnetRPC, "Flare mainnet rpc")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	client, err := ethclient.DialContext(ctx, *rpc)
	if err != nil {
		die("dial %s: %v", *rpc, err)
	}
	parsed, err := abi.JSON(strings.NewReader(erc20ABI))
	if err != nil {
		die("abi: %v", err)
	}
	r := &reader{ctx: ctx, client: client, abi: parsed}

	fxrp := common.HexToAddress(fxrpAddr)
	supply := r.uint(fxrp, "totalSupply")
	block, err := client.BlockNumber(ctx)
	if err != nil {
		die("block number: %v", err)
	}

	fmt.Printf("\nFXRP on Flare mainnet — read at block %d\n", block)
	fmt.Printf("  %s\n\n", fxrpAddr)
	fmt.Printf("  supply  %18s FXRP\n\n", amount(supply, 6))

	// ── where the float is ────────────────────────────────────────────────
	fmt.Println("Where the float sits")
	fmt.Println(strings.Repeat("─", 96))
	total := big.NewInt(0)
	for _, h := range parked {
		bal := r.balanceOf(fxrp, common.HexToAddress(h.addr))
		total.Add(total, bal)
		fmt.Printf("  %-22s %14s FXRP  %5s   %s\n",
			h.name, amount(bal, 6), pct(bal, supply), h.note)
	}
	fmt.Printf("  %-22s %14s FXRP  %5s\n\n", "four contracts", amount(total, 6), pct(total, supply))

	// ── what could actually absorb a seller ───────────────────────────────
	fmt.Println("What a seller can trade into")
	fmt.Println(strings.Repeat("─", 96))
	poolFxrp, exitDepth := big.NewInt(0), big.NewInt(0)
	nExit := 0
	for _, p := range pools {
		a := common.HexToAddress(p.addr)
		t0, t1 := r.addr(a, "token0"), r.addr(a, "token1")
		if t0 == (common.Address{}) {
			continue
		}
		other := t0
		if t0 == fxrp {
			other = t1
		}
		sym := r.str(other, "symbol")
		dec := r.decimals(other)
		mine := r.balanceOf(fxrp, a)
		theirs := r.balanceOf(other, a)
		poolFxrp.Add(poolFxrp, mine)

		flag := " "
		if stable[sym] {
			flag = "*"
			exitDepth.Add(exitDepth, theirs)
			nExit++
		}
		fmt.Printf(" %s %s  %11s FXRP  ⇄  %14s %s\n", flag, p.addr, amount(mine, 6), amount(theirs, dec), sym)
	}
	fmt.Println()
	fmt.Printf("  in DEX pools at all          %14s FXRP  %5s of supply\n", amount(poolFxrp, 6), pct(poolFxrp, supply))
	fmt.Printf("  * stablecoin on the far side %14s        %5s of supply, across %d pools\n\n",
		amount(exitDepth, 6), pct(exitDepth, supply), nExit)

	fmt.Println(strings.Repeat("─", 96))
	fmt.Printf("  %s FXRP outstanding. %s of stablecoin on the other side of the trade.\n",
		amount(supply, 6), amount(exitDepth, 6))
	fmt.Println("  Pools priced in stXRP, WFLR or WETH are not an exit — they are the same")
	fmt.Println("  risk in a different wrapper. Only the starred rows let a holder leave.")
	fmt.Println()
	fmt.Println("  This is not a liquidity mining problem. Flare spent 2.2 billion FLR on")
	fmt.Println("  one, and the float responded by sitting in vaults or leaving. Depth is")
	fmt.Println("  absent because quoting it publicly is what it costs — which is the one")
	fmt.Println("  thing an ordinary smart contract cannot fix, and the reason for Nightjar.")
	fmt.Println()
}

// ── plumbing ──────────────────────────────────────────────────────────────

type reader struct {
	ctx    context.Context
	client *ethclient.Client
	abi    abi.ABI
}

func (r *reader) call(to common.Address, method string, args ...interface{}) []interface{} {
	in, err := r.abi.Pack(method, args...)
	if err != nil {
		die("pack %s: %v", method, err)
	}
	out, err := r.client.CallContract(r.ctx, ethereum.CallMsg{To: &to, Data: in}, nil)
	if err != nil || len(out) == 0 {
		return nil
	}
	vals, err := r.abi.Unpack(method, out)
	if err != nil {
		return nil
	}
	return vals
}

func (r *reader) uint(to common.Address, method string) *big.Int {
	v := r.call(to, method)
	if len(v) == 0 {
		return big.NewInt(0)
	}
	n, _ := v[0].(*big.Int)
	if n == nil {
		return big.NewInt(0)
	}
	return n
}

func (r *reader) balanceOf(token, who common.Address) *big.Int {
	v := r.call(token, "balanceOf", who)
	if len(v) == 0 {
		return big.NewInt(0)
	}
	n, _ := v[0].(*big.Int)
	if n == nil {
		return big.NewInt(0)
	}
	return n
}

func (r *reader) addr(to common.Address, method string) common.Address {
	v := r.call(to, method)
	if len(v) == 0 {
		return common.Address{}
	}
	a, _ := v[0].(common.Address)
	return a
}

func (r *reader) str(to common.Address, method string) string {
	v := r.call(to, method)
	if len(v) == 0 {
		return "?"
	}
	s, _ := v[0].(string)
	return s
}

func (r *reader) decimals(to common.Address) int {
	v := r.call(to, "decimals")
	if len(v) == 0 {
		return 18
	}
	d, _ := v[0].(uint8)
	return int(d)
}

// amount renders a fixed-point token amount with thousands separators and no
// fractional part — every number here is large enough that cents are noise.
func amount(v *big.Int, decimals int) string {
	if v == nil {
		return "0"
	}
	unit := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
	whole := new(big.Int).Div(v, unit).String()
	var b strings.Builder
	for i, c := range whole {
		if i > 0 && (len(whole)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	return b.String()
}

func pct(part, whole *big.Int) string {
	if whole == nil || whole.Sign() == 0 {
		return "—"
	}
	scaled := new(big.Int).Mul(part, big.NewInt(10000))
	scaled.Div(scaled, whole)
	return fmt.Sprintf("%d.%02d%%", scaled.Int64()/100, scaled.Int64()%100)
}

func die(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "fxrp-depth: "+format+"\n", args...)
	os.Exit(1)
}

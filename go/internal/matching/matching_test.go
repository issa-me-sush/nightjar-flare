package matching

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"

	"nightjar/pkg/types"
)

// price builds a fixed-point price from a whole-number quote-per-base value.
func price(whole int64) *big.Int {
	return new(big.Int).Mul(big.NewInt(whole), types.PriceScale)
}

// priceFrac builds a price of `num/den` quote per base.
func priceFrac(num, den int64) *big.Int {
	p := new(big.Int).Mul(big.NewInt(num), types.PriceScale)
	return p.Div(p, big.NewInt(den))
}

func addr(b byte) common.Address {
	var a common.Address
	a[19] = b
	return a
}

func buy(id uint64, trader byte, limit *big.Int, size int64) Order {
	return Order{ID: id, Trader: addr(trader), Side: types.SideBuy, LimitPrice: limit, Size: big.NewInt(size)}
}

func sell(id uint64, trader byte, limit *big.Int, size int64) Order {
	return Order{ID: id, Trader: addr(trader), Side: types.SideSell, LimitPrice: limit, Size: big.NewInt(size)}
}

func TestClearSimpleCross(t *testing.T) {
	orders := []Order{
		buy(1, 0xA, price(3), 100),
		sell(2, 0xB, price(2), 100),
	}

	s, err := Clear(orders, price(3), 10000)
	if err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if s.MatchedBase.Int64() != 100 {
		t.Errorf("matched = %s, want 100", s.MatchedBase)
	}
	if len(s.Fills) != 2 {
		t.Fatalf("fills = %d, want 2", len(s.Fills))
	}
	if s.Unmatched != 0 {
		t.Errorf("unmatched = %d, want 0", s.Unmatched)
	}
}

// Both sides settle at one price — the buyer never pays their full limit just
// because they bid aggressively. This is the property that removes the payoff
// from ordering games.
func TestUniformPriceBenefitsBothSides(t *testing.T) {
	orders := []Order{
		buy(1, 0xA, price(10), 50), // willing to pay 10
		sell(2, 0xB, price(6), 50), // willing to accept 6
	}

	s, err := Clear(orders, price(8), 10000)
	if err != nil {
		t.Fatalf("Clear: %v", err)
	}

	var buyerQuote, sellerQuote *big.Int
	for _, f := range s.Fills {
		if f.Trader == addr(0xA) {
			buyerQuote = f.QuoteDelta
		}
		if f.Trader == addr(0xB) {
			sellerQuote = f.QuoteDelta
		}
	}
	if buyerQuote == nil || sellerQuote == nil {
		t.Fatal("missing fills for one side")
	}

	// Conservation: the quote the buyer pays is exactly what the seller receives.
	if new(big.Int).Add(buyerQuote, sellerQuote).Sign() != 0 {
		t.Errorf("quote not conserved: buyer %s, seller %s", buyerQuote, sellerQuote)
	}
	// The buyer pays strictly less than their limit of 10 * 50 = 500.
	paid := new(big.Int).Neg(buyerQuote)
	if paid.Cmp(big.NewInt(500)) >= 0 {
		t.Errorf("buyer paid %s, expected less than their limit 500", paid)
	}
}

func TestClearMaximisesVolume(t *testing.T) {
	// At price 5 only 10 units cross; at price 4, 30 units cross.
	orders := []Order{
		buy(1, 0xA, price(5), 10),
		buy(2, 0xB, price(4), 20),
		sell(3, 0xC, price(4), 30),
	}

	s, err := Clear(orders, price(4), 10000)
	if err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if s.MatchedBase.Int64() != 30 {
		t.Errorf("matched = %s, want 30 (volume-maximising price)", s.MatchedBase)
	}
	if s.ClearingPrice.Cmp(price(4)) != 0 {
		t.Errorf("clearing = %s, want 4e18", s.ClearingPrice)
	}
}

func TestNoCrossReturnsError(t *testing.T) {
	orders := []Order{
		buy(1, 0xA, price(2), 100),
		sell(2, 0xB, price(5), 100), // asks far above the bid
	}
	if _, err := Clear(orders, price(3), 10000); err != ErrNoCross {
		t.Errorf("err = %v, want ErrNoCross", err)
	}
}

// A book manipulated far away from the oracle price must not settle. This is
// the check that keeps a compromised or buggy book from clearing at an absurd
// price, and it is enforced again independently on-chain.
func TestOutOfBandBatchRejected(t *testing.T) {
	orders := []Order{
		buy(1, 0xA, price(100), 10),
		sell(2, 0xB, price(100), 10),
	}
	// Reference is 2; clearing at 100 is a 4900% deviation. Allow 5%.
	if _, err := Clear(orders, price(2), 500); err != ErrOutOfBand {
		t.Errorf("err = %v, want ErrOutOfBand", err)
	}
}

func TestWithinBandBoundary(t *testing.T) {
	orders := []Order{
		buy(1, 0xA, priceFrac(105, 100), 10),
		sell(2, 0xB, priceFrac(105, 100), 10),
	}
	// Exactly 5% above a reference of 1.0, with a 5% tolerance: allowed.
	if _, err := Clear(orders, price(1), 500); err != nil {
		t.Errorf("boundary should be inclusive, got %v", err)
	}
	// The same clearing price against a 4.99% tolerance: rejected.
	if _, err := Clear(orders, price(1), 499); err != ErrOutOfBand {
		t.Errorf("err = %v, want ErrOutOfBand", err)
	}
}

// Partial fills leave the short side fully satisfied and the long side rationed.
func TestPartialFillRationsLongSide(t *testing.T) {
	orders := []Order{
		buy(1, 0xA, price(5), 100),
		buy(2, 0xB, price(5), 100),
		sell(3, 0xC, price(5), 60),
	}

	s, err := Clear(orders, price(5), 10000)
	if err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if s.MatchedBase.Int64() != 60 {
		t.Errorf("matched = %s, want 60 (limited by supply)", s.MatchedBase)
	}

	// Base must net to zero across all participants.
	total := big.NewInt(0)
	for _, f := range s.Fills {
		total.Add(total, f.BaseDelta)
	}
	if total.Sign() != 0 {
		t.Errorf("base not conserved: net %s", total)
	}
}

// The same book must clear identically regardless of arrival order, otherwise
// two TEEs serving the same batch could disagree.
func TestDeterministicUnderReordering(t *testing.T) {
	base := []Order{
		buy(1, 0xA, price(5), 40),
		buy(2, 0xB, price(6), 30),
		sell(3, 0xC, price(4), 50),
		sell(4, 0xD, price(5), 25),
	}
	reversed := make([]Order, len(base))
	for i, o := range base {
		reversed[len(base)-1-i] = o
	}

	a, err := Clear(base, price(5), 10000)
	if err != nil {
		t.Fatalf("Clear(base): %v", err)
	}
	b, err := Clear(reversed, price(5), 10000)
	if err != nil {
		t.Fatalf("Clear(reversed): %v", err)
	}

	if a.ClearingPrice.Cmp(b.ClearingPrice) != 0 {
		t.Errorf("clearing price differs: %s vs %s", a.ClearingPrice, b.ClearingPrice)
	}
	if a.MatchedBase.Cmp(b.MatchedBase) != 0 {
		t.Errorf("matched differs: %s vs %s", a.MatchedBase, b.MatchedBase)
	}
}

// Orders that do not trade are counted but never described.
func TestUnmatchedOrdersCountedNotRevealed(t *testing.T) {
	orders := []Order{
		buy(1, 0xA, price(5), 10),
		sell(2, 0xB, price(5), 10),
		buy(3, 0xC, price(1), 999), // far from the market, never trades
	}

	s, err := Clear(orders, price(5), 10000)
	if err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if s.Unmatched != 1 {
		t.Errorf("unmatched = %d, want 1", s.Unmatched)
	}
	for _, f := range s.Fills {
		if f.Trader == addr(0xC) {
			t.Error("non-trading order leaked into the settlement")
		}
	}
}

func TestQuoteForTruncates(t *testing.T) {
	// 3 base at 1.5 quote/base = 4.5, truncated to 4.
	got := QuoteFor(big.NewInt(3), priceFrac(3, 2))
	if got.Int64() != 4 {
		t.Errorf("QuoteFor = %s, want 4", got)
	}
}

func TestEmptyBook(t *testing.T) {
	if _, err := Clear(nil, price(5), 10000); err != ErrNoCross {
		t.Errorf("err = %v, want ErrNoCross", err)
	}
}

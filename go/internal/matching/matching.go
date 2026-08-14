// Package matching implements a uniform-price sealed-bid batch auction.
//
// The engine is deliberately pure: it takes a set of orders and a reference
// price and returns a settlement. It performs no I/O and holds no state, so
// the economically load-bearing logic is testable without a TEE, a chain, or
// a network. Everything in this package runs only inside the enclave.
package matching

import (
	"errors"
	"math/big"
	"sort"

	"github.com/ethereum/go-ethereum/common"

	"nightjar/pkg/types"
)

// ErrNoCross is returned when no price clears any volume.
var ErrNoCross = errors.New("no crossing orders in batch")

// ErrOutOfBand is returned when the clearing price deviates from the oracle
// reference by more than the caller's tolerance. The batch is abandoned rather
// than settled, so a manipulated book cannot drag the venue away from the
// market price.
var ErrOutOfBand = errors.New("clearing price outside oracle band")

// Order is a decrypted order resting in the book. It exists only in enclave
// memory; the ciphertext it came from is all that ever touched the chain.
type Order struct {
	ID         uint64
	Trader     common.Address
	Side       types.Side
	LimitPrice *big.Int
	Size       *big.Int
}

// Settlement is the outcome of clearing one batch.
type Settlement struct {
	ClearingPrice *big.Int
	MatchedBase   *big.Int
	Fills         []types.Fill
	// Unmatched counts orders that did not trade at all.
	Unmatched int
}

// QuoteFor converts a base amount to quote at the given price:
//
//	quote = base * price / PriceScale
//
// Division truncates, which rounds in favour of the counterparty paying quote.
func QuoteFor(base, price *big.Int) *big.Int {
	q := new(big.Int).Mul(base, price)
	return q.Div(q, types.PriceScale)
}

// Clear runs the uniform-price auction.
//
// The clearing price is the price that maximises matched volume. Ties are
// broken by smallest supply/demand imbalance, then by proximity to the oracle
// reference, then by the lower price — a total order, so two enclaves running
// the same book always agree.
//
// Every fill executes at the same clearing price. That is what removes the
// advantage of being early or being ordered favourably in a block: within a
// batch there is no such thing as a better position in the queue.
func Clear(orders []Order, refPrice *big.Int, maxDeviationBps uint32) (*Settlement, error) {
	if len(orders) == 0 {
		return nil, ErrNoCross
	}

	candidates := candidatePrices(orders)

	var (
		bestPrice   *big.Int
		bestMatched = big.NewInt(0)
		bestImbal   *big.Int
	)

	for _, p := range candidates {
		demand, supply := depthAt(orders, p)
		matched := minBig(demand, supply)
		if matched.Sign() == 0 {
			continue
		}
		imbal := new(big.Int).Abs(new(big.Int).Sub(demand, supply))

		if bestPrice == nil || better(matched, imbal, p, bestMatched, bestImbal, bestPrice, refPrice) {
			bestPrice, bestMatched, bestImbal = p, matched, imbal
		}
	}

	if bestPrice == nil || bestMatched.Sign() == 0 {
		return nil, ErrNoCross
	}

	if !withinBand(bestPrice, refPrice, maxDeviationBps) {
		return nil, ErrOutOfBand
	}

	fills, traded := allocate(orders, bestPrice, bestMatched)

	return &Settlement{
		ClearingPrice: bestPrice,
		MatchedBase:   bestMatched,
		Fills:         fills,
		Unmatched:     len(orders) - traded,
	}, nil
}

// better reports whether candidate (m,i,p) beats incumbent (bm,bi,bp).
func better(m, i, p, bm, bi, bp, ref *big.Int) bool {
	if c := m.Cmp(bm); c != 0 {
		return c > 0 // more volume wins
	}
	if c := i.Cmp(bi); c != 0 {
		return c < 0 // smaller imbalance wins
	}
	if ref != nil && ref.Sign() > 0 {
		dp := new(big.Int).Abs(new(big.Int).Sub(p, ref))
		dbp := new(big.Int).Abs(new(big.Int).Sub(bp, ref))
		if c := dp.Cmp(dbp); c != 0 {
			return c < 0 // closer to oracle wins
		}
	}
	return p.Cmp(bp) < 0 // deterministic final tie-break
}

// candidatePrices returns the distinct limit prices, ascending. The optimum of
// a step function like matched-volume always sits on one of these.
func candidatePrices(orders []Order) []*big.Int {
	seen := make(map[string]bool, len(orders))
	out := make([]*big.Int, 0, len(orders))
	for _, o := range orders {
		k := o.LimitPrice.String()
		if !seen[k] {
			seen[k] = true
			out = append(out, new(big.Int).Set(o.LimitPrice))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Cmp(out[j]) < 0 })
	return out
}

// depthAt returns total buy interest at or above p, and total sell interest at
// or below p.
func depthAt(orders []Order, p *big.Int) (demand, supply *big.Int) {
	demand, supply = big.NewInt(0), big.NewInt(0)
	for _, o := range orders {
		switch o.Side {
		case types.SideBuy:
			if o.LimitPrice.Cmp(p) >= 0 {
				demand.Add(demand, o.Size)
			}
		case types.SideSell:
			if o.LimitPrice.Cmp(p) <= 0 {
				supply.Add(supply, o.Size)
			}
		}
	}
	return demand, supply
}

// allocate fills `volume` of base on each side at `price`, using price
// priority then order ID, and aggregates the result into per-trader deltas.
func allocate(orders []Order, price, volume *big.Int) ([]types.Fill, int) {
	buys, sells := eligible(orders, price)

	// Best price first; ID ascending as the deterministic secondary key.
	sort.Slice(buys, func(i, j int) bool {
		if c := buys[i].LimitPrice.Cmp(buys[j].LimitPrice); c != 0 {
			return c > 0
		}
		return buys[i].ID < buys[j].ID
	})
	sort.Slice(sells, func(i, j int) bool {
		if c := sells[i].LimitPrice.Cmp(sells[j].LimitPrice); c != 0 {
			return c < 0
		}
		return sells[i].ID < sells[j].ID
	})

	type delta struct {
		base  *big.Int
		quote *big.Int
	}
	acc := map[common.Address]*delta{}
	order := []common.Address{}
	traded := 0

	touch := func(a common.Address) *delta {
		d, ok := acc[a]
		if !ok {
			d = &delta{base: big.NewInt(0), quote: big.NewInt(0)}
			acc[a] = d
			order = append(order, a)
		}
		return d
	}

	fillSide := func(side []Order, buy bool) {
		remaining := new(big.Int).Set(volume)
		for _, o := range side {
			if remaining.Sign() == 0 {
				break
			}
			take := minBig(remaining, o.Size)
			if take.Sign() == 0 {
				continue
			}
			quote := QuoteFor(take, price)
			d := touch(o.Trader)
			if buy {
				d.base.Add(d.base, take)
				d.quote.Sub(d.quote, quote)
			} else {
				d.base.Sub(d.base, take)
				d.quote.Add(d.quote, quote)
			}
			remaining.Sub(remaining, take)
			traded++
		}
	}

	fillSide(buys, true)
	fillSide(sells, false)

	fills := make([]types.Fill, 0, len(order))
	for _, a := range order {
		d := acc[a]
		fills = append(fills, types.Fill{Trader: a, BaseDelta: d.base, QuoteDelta: d.quote})
	}
	return fills, traded
}

// eligible splits orders into those willing to trade at price.
func eligible(orders []Order, price *big.Int) (buys, sells []Order) {
	for _, o := range orders {
		switch o.Side {
		case types.SideBuy:
			if o.LimitPrice.Cmp(price) >= 0 {
				buys = append(buys, o)
			}
		case types.SideSell:
			if o.LimitPrice.Cmp(price) <= 0 {
				sells = append(sells, o)
			}
		}
	}
	return buys, sells
}

// withinBand reports whether price is within maxDeviationBps of ref.
// A zero or absent reference disables the check.
func withinBand(price, ref *big.Int, maxDeviationBps uint32) bool {
	if ref == nil || ref.Sign() <= 0 {
		return true
	}
	diff := new(big.Int).Abs(new(big.Int).Sub(price, ref))
	// diff/ref <= bps/10000  ->  diff*10000 <= ref*bps
	lhs := new(big.Int).Mul(diff, big.NewInt(10000))
	rhs := new(big.Int).Mul(ref, big.NewInt(int64(maxDeviationBps)))
	return lhs.Cmp(rhs) <= 0
}

func minBig(a, b *big.Int) *big.Int {
	if a.Cmp(b) <= 0 {
		return new(big.Int).Set(a)
	}
	return new(big.Int).Set(b)
}

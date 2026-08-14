import Link from "next/link";
import { Nav } from "./nav";
import { SealDemo } from "./seal-demo";
import { BASE_SYMBOL, QUOTE_SYMBOL, VENUE, EXTENSION_ID, coston2 } from "@/lib/config";

export const metadata = {
  title: "Nightjar — trade FXRP without showing your hand",
  description:
    "An on-chain venue where your order stays encrypted until it is matched. The privacy an OTC desk sells, without the desk.",
};

const EXPLORER = coston2.blockExplorers.default.url;

/** A ledger row: label, dotted leader, value. */
function Row({ k, v, big }: { k: string; v: React.ReactNode; big?: boolean }) {
  return (
    <div>
      <span className="k">{k}</span>
      <span className="lead" />
      <span className={big ? "v big" : "v"}>{v}</span>
    </div>
  );
}

/** One section of the sheet: a gutter label and its column of content. */
function Sheet({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="sheet">
      <div className="gut">
        {label}
        {sub && <span className="sub">{sub}</span>}
      </div>
      <div className="col">{children}</div>
    </div>
  );
}

export default function Landing() {
  return (
    <>
      <Nav
        right={
          <Link href="/trade">
            <button className="primary">Open terminal</button>
          </Link>
        }
      />

      <main className="wrap" style={{ paddingBottom: 80 }}>
        {/* ── hero ─────────────────────────────────────────────────────── */}
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1.08fr) minmax(300px, .92fr)",
            gap: 56,
            alignItems: "center",
            padding: "76px 0 72px",
          }}
          className="hero"
        >
          <div className="stack" style={{ gap: 26 }}>
            <p className="eyebrow">Flare Confidential Compute</p>
            <h1>
              Trade FXRP without
              <br />
              showing your hand.
            </h1>
            <p className="lede">
              Put a large order on any public book and you have announced it. Your price and
              your size are readable before you trade, and you get a worse fill. Nightjar
              keeps your order encrypted until the moment it is matched.
            </p>
            <p className="small" style={{ maxWidth: "42ch" }}>
              It is the privacy an OTC desk sells, without the desk — atomic on-chain
              settlement, and no counterparty who learns your position.
            </p>
            <div className="row gap12 wrapf">
              <Link href="/trade">
                <button className="primary lg">Open terminal</button>
              </Link>
              <Link href="/proof">
                <button className="lg ghost">See the proof</button>
              </Link>
            </div>
          </div>

          <SealDemo />
        </section>

        {/* ── the sheet ────────────────────────────────────────────────── */}

        <Sheet label="The problem" sub="read from Flare mainnet">
          <div className="stack gap32">
            <div className="figure">
              <span className="n">0.82%</span>
              <p className="cap">
                of FXRP&rsquo;s float has stablecoin waiting on the other side of the trade.
                149.6 million tokens outstanding; about 1.23 million dollars to sell into.
                If one holder in a hundred wanted out at once, there is no price at which
                they all get out.
              </p>
            </div>

            <p className="body">
              That is not a figure from a dashboard. It is read live off Flare mainnet, and
              the shape underneath it is worse than the headline: <strong>84% of all
              FXRP sits in four contracts</strong> — a yield vault, two lending markets, and
              the bridge adapter that carries it off Flare. None of them quotes a price. The
              fourth-largest holder of FXRP is the thing taking it somewhere else.
            </p>

            <div className="ledger">
              <Row k="Supply" v="149,614,009 FXRP" />
              <Row k="Parked in four contracts" v="84.43%" />
              <Row k="Already bridged off Flare" v={<span className="exposed">10.77%</span>} />
              <Row k="Stablecoin you could sell into" v={<span className="exposed">1,230,170</span>} big />
            </div>

            <p className="body">
              Incentives have already been tried at scale, and the float responded by sitting
              in vaults or leaving. Rented liquidity leaves when the rent stops, because the
              reason it was never there was not the yield. Resting real size on a public book
              means publishing your intention before it fills — so the people with size
              rationally do not show up.
            </p>

            <div className="row gap12 wrapf">
              <Link href="/depth">
                <button className="ghost">Check the numbers yourself</button>
              </Link>
            </div>
          </div>
        </Sheet>

        <Sheet label="The cost" sub="measured on-chain">
          <div className="stack gap32">
            <div className="figure">
              <span className="n">392 bps</span>
              <p className="cap">
                is what a transparent order book cost the buyer, against this one. Same buyer,
                same seller, same size — the only difference was whether her limit price could
                be read.
              </p>
            </div>

            <p className="body">
              We did not want to assert that, so we deployed an ordinary on-chain limit order
              book as a control and ran the identical trade through both. On the transparent
              one the seller called a public view function, read that the buyer would pay up
              to 1.06, and asked exactly that instead of the 1.02 he would have accepted. No
              mempool games, no searcher infrastructure — reading public state was enough.
            </p>

            <div className="compare">
              <div className="side">
                <span className="label" style={{ color: "var(--amber)" }}>
                  transparent book
                </span>
                <div className="ledger">
                  <Row k="Her limit" v="1.06 · public" />
                  <Row k="Executed at" v={<span className="exposed">1.06</span>} />
                  <Row k="She paid" v="3.180000" big />
                </div>
              </div>
              <div className="div" />
              <div className="side">
                <span className="label" style={{ color: "var(--jade)" }}>
                  nightjar
                </span>
                <div className="ledger">
                  <Row k="Her limit" v="1.06 · sealed" />
                  <Row k="Executed at" v={<span className="sealed">1.02</span>} />
                  <Row k="She paid" v="3.060000" big />
                </div>
              </div>
            </div>
          </div>
        </Sheet>

        <Sheet label="The design" sub="why an auction">
          <div className="stack gap24">
            <h2>A batch auction is the only rule that survives more than one enclave.</h2>
            <p className="body">
              The obvious way to build this is a normal price-time-priority order book inside
              a secure enclave. It works, and it costs you the ability to ever run a second
              one. Price-time priority is a function of arrival order: two enclaves fed the
              same orders over a network see them in different sequences, produce different
              matches, and sign different settlements. There is nothing for them to agree on.
            </p>
            <p className="body">
              A uniform-price batch auction has no such dependency. It consumes a{" "}
              <em>set</em> of orders and returns the single price that matches the most
              volume — feed it the same set in any order and every enclave emits identical
              bytes. So the venue can require <strong>k independent enclaves to sign the same
              settlement</strong> before the chain will execute it, and the contract enforces
              that they are distinct and registered.
            </p>
            <div className="note jade">
              <strong>This matters more than it did two years ago.</strong> Public research in
              2025 demonstrated sub-$1,000 memory-bus attacks that forge TEE attestations on
              both major vendors, who treat physical interposition as out of scope with no fix
              planned. A venue resting on exactly one machine now has a cheap, known,
              unpatched single point of failure. We have not solved TEE security — we chose
              the matching rule that lets you defend against it. The quorum path is deployed
              and tested; Coston2 runs one enclave today because a second needs a second host.
            </div>
          </div>
        </Sheet>

        <Sheet label="Who it is for" sub="and who it is not">
          <div className="stack gap24">
            <h2>The people who currently pick up the phone.</h2>
            <p className="body">
              When someone wants to move real size in crypto today, they do not use a DEX. They
              message an OTC desk, take a private quote, and settle bilaterally. That entire
              industry exists for one reason: public books leak intentions.
            </p>

            <div className="ledger" style={{ marginTop: 4 }}>
              <Row k="Desks moving size" v="split across thirty fills, still detected" />
              <Row k="Market makers" v="quoting real size means adverse selection" />
              <Row k="Treasuries and funds" v="cannot rebalance without broadcasting" />
            </div>

            <p className="small">
              Not for someone swapping 50 {BASE_SYMBOL} — too small to be worth anyone&rsquo;s
              attention, and an ordinary DEX serves them fine. This is infrastructure for size.
            </p>
          </div>
        </Sheet>

        <Sheet label="The business" sub="5 bps">
          <div className="stack gap24">
            <h2>Charged only on volume it actually matches.</h2>
            <p className="body">
              Five basis points of matched notional against roughly the 392 the trader keeps. An
              order that never matches is free — the right incentive for a venue whose whole
              promise is that you can rest size without consequence. The ceiling is fixed in the
              bytecode, so governance can lower the fee and can never raise it past that.
            </p>
            <div className="ledger">
              <Row k="Protocol fee" v="5 bps of matched notional" />
              <Row k="Ceiling, unraisable" v="30 bps" />
              <Row k="Fee on an unmatched order" v={<span className="sealed">zero</span>} />
              <Row k="Charged to" v="both sides of a fill" />
            </div>
          </div>
        </Sheet>

        <Sheet label="How it works" sub="four steps">
          <div className="stack gap24">
            <h2>Sealed in your browser. Matched in an enclave. Settled on-chain.</h2>
            <div className="ledger">
              <Row k="01 · Deposit" v="decoupled from any order" />
              <Row k="02 · Seal" v="encrypted to the enclave key" />
              <Row k="03 · Clear" v="one price for the whole batch" />
              <Row k="04 · Settle" v="quorum, oracle band, conservation" />
            </div>
            <p className="body">
              Funding is deliberately separate from ordering: if you funded the exact size of each
              trade, the transfer itself would leak it. The venue stores ciphertext and one public
              number — how many orders are in the batch. The enclave finds the single price that
              matches the most volume, and everyone in that batch trades at it, so being early or
              ordered favourably in a block is worth nothing.
            </p>
            <div className="note jade">
              <strong>The enclave is not something new to trust.</strong> It never holds your
              funds — it returns signed balance deltas, and the contract rejects them unless both
              assets net to exactly zero and the clearing price sits inside a band around
              Flare&rsquo;s own FTSO feed, re-read on-chain at settlement. A valid enclave
              signature is necessary, and deliberately not sufficient. The enclave proposes; the
              chain disposes.
            </div>
          </div>
        </Sheet>

        <Sheet label="Why Flare" sub="the liquidity problem">
          <div className="stack gap24">
            <h2>You cannot buy the liquidity that hides from you.</h2>
            <p className="body">
              Flare has committed billions of FLR to bringing liquidity to FXRP. But the deepest
              liquidity — resting institutional size — is not absent for want of incentives. It is
              absent because resting size on a transparent book means revealing it, and the people
              with size respond rationally by not showing up. Incentives rent liquidity. Removing
              the reason to hide is how you earn it.
            </p>
            <p className="body">
              That is the one problem a smart contract cannot solve, because on-chain state is
              public by construction. It needs confidential execution — which Flare shipped, and
              which its own roadmap names dark pools and sealed-bid auctions as the reason for.
            </p>
          </div>
        </Sheet>

        <Sheet label="Deployment" sub="Coston2">
          <div className="stack gap20">
            <div className="ledger">
              <Row
                k="Venue"
                v={
                  <a href={`${EXPLORER}/address/${VENUE}`} target="_blank" rel="noreferrer">
                    {VENUE.slice(0, 10)}…{VENUE.slice(-6)}
                  </a>
                }
              />
              <Row k="FCC extension" v={EXTENSION_ID} />
              <Row k="Market" v={`${BASE_SYMBOL} / ${QUOTE_SYMBOL}`} />
              <Row k="Base asset" v="real FAssets FXRP" />
              <Row k="Enclave quorum" v="1 of 1 registered · k-of-n live" />
            </div>
            <div className="row gap12 wrapf">
              <Link href="/trade">
                <button className="primary lg">Open terminal</button>
              </Link>
              <Link href="/proof">
                <button className="lg ghost">Verify it yourself</button>
              </Link>
            </div>
          </div>
        </Sheet>

        <footer
          className="between wrapf"
          style={{ paddingTop: 24, borderTop: "1px solid var(--hair)" }}
        >
          <span className="tiny">
            Testnet only. {QUOTE_SYMBOL} stands in for USD₮0, which Coston2 does not have.
          </span>
          <a
            className="tiny"
            href="https://github.com/issa-me-sush/nightjar-flare"
            target="_blank"
            rel="noreferrer"
          >
            github.com/issa-me-sush/nightjar-flare
          </a>
        </footer>
      </main>

      <style>{`
        @media (max-width: 940px) {
          .hero { grid-template-columns: 1fr !important; gap: 40px !important; }
        }
      `}</style>
    </>
  );
}

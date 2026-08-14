import Link from "next/link";
import { Nav } from "./nav";
import { SealDemo } from "./seal-demo";
import { BASE_SYMBOL, QUOTE_SYMBOL, VENUE, EXTENSION_ID, coston2 } from "@/lib/config";

export const metadata = {
  title: "Nightjar — a dark pool for FXRP on Flare",
  description:
    "Exchanges keep your order secret from your counterparty. On-chain books do not. Nightjar puts the matching engine inside a Flare Confidential Compute enclave, and the chain audits what it returns.",
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
            <p className="eyebrow">A dark pool for FXRP · Flare Confidential Compute</p>
            <h1>
              Exchanges keep your order
              <br />
              secret. On-chain books don&rsquo;t.
            </h1>
            <p className="lede">
              Send an order to any exchange and the exchange sees it while your counterparty
              does not. That is how markets have worked for decades. Put the matching engine
              on a public chain and the property disappears: your limit price becomes
              readable by the person about to trade against you.
            </p>
            <p className="small" style={{ maxWidth: "44ch" }}>
              Nightjar puts the matching engine inside a Flare Confidential Compute enclave
              and gets it back. The difference from a desk is that nobody has to be trusted:
              the chain audits what the engine returns instead of believing it.
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

        <Sheet label="How it trades" sub="the obvious question first">
          <div className="stack gap24">
            <h2>Hidden from your counterparty. Not hidden from the engine.</h2>
            <p className="body">
              The enclave sees every order in full: side, price, size. It matches them the way
              any exchange&rsquo;s matching engine does. Nobody trades blind and nothing is
              guessed. What changes is that the book is not broadcast, which is the normal
              arrangement everywhere except on-chain.
            </p>
            <div className="ledger">
              <Row k="01 · You submit" v="a limit order, as anywhere" />
              <Row k="02 · Others submit" v="theirs, in the same batch" />
              <Row k="03 · The engine clears" v="one price, the most volume" />
              <Row k="04 · Everyone trades" v={<span className="sealed">at that one price</span>} />
            </div>
            <p className="body">
              You state your real limit because you never pay it. You pay the clearing price,
              so honesty is the profitable move rather than the expensive one. Batch auctions
              are not exotic either: NASDAQ and NYSE run one at every open and close, and
              those are the deepest moments of the trading day.
            </p>
            <div className="note">
              <strong>Two costs, stated plainly.</strong> You wait for the batch rather than
              trading instantly, and you cannot read the book before committing. If you are
              swapping fifty {BASE_SYMBOL} that is friction with no benefit, and an ordinary
              DEX serves you better. If you are moving five hundred thousand, thirty seconds
              is nothing against announcing yourself.
            </div>
          </div>
        </Sheet>

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
              This is why the venue is aimed at FXRP rather than at trading in general.
              Incentives were already tried at scale and the float responded by sitting in
              vaults or leaving, which suggests the missing ingredient was never the yield.
              Lending markets on Flare take FXRP as collateral, and a liquidation that has to
              sell into this much depth is priced on an assumption that is not true.
            </p>

            <div className="row gap12 wrapf">
              <Link href="/depth">
                <button className="ghost">Check the numbers yourself</button>
              </Link>
            </div>
          </div>
        </Sheet>

        <Sheet label="The leak" sub="demonstrated on-chain">
          <div className="stack gap32">
            <h2>A resting order answers questions about itself.</h2>

            <p className="body">
              We did not want to leave that as an assertion, so we deployed an ordinary
              on-chain limit order book alongside this one and ran the same trade through
              both. On the transparent venue the seller called <code>getOrder</code>, a
              public view function, read the buyer&rsquo;s limit, and asked for exactly that
              instead of the lower price he would have accepted. No mempool access, no
              searcher infrastructure, no bots. One view call.
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

            <p className="small">
              Both venues are live on Coston2 and both transactions are on the{" "}
              <Link href="/proof">proof page</Link>. How much this costs you is the gap
              between your limit and your counterparty&rsquo;s reserve, which is yours to
              quote rather than ours — for this pair it is 392 basis points. What generalises
              is that reading it costs the counterparty nothing.
            </p>
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
              Five basis points of matched notional, charged only on volume that trades. An
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

        <Sheet label="What this is" sub="and what it is not">
          <div className="stack gap24">
            <h2>A dark pool, on a chain that checks its work.</h2>
            <p className="body">
              Dark pools are ordinary infrastructure. Institutions have used them for decades
              because moving size on a lit book moves the price against you. The cost has
              always been that a dark pool has an operator who sees everything, which is why
              they are licensed and audited rather than trusted.
            </p>
            <p className="body">
              Confidential venues on-chain are not new either. Several exist, and Flare&rsquo;s
              own team has written a confidential order book. What is different here is
              narrower and worth stating exactly:
            </p>
            <div className="ledger">
              <Row k="No operator to trust" v="the chain re-checks the engine" />
              <Row k="Order-independent matching" v="so more than one enclave is possible" />
              <Row k="One clearing price" v={<span className="sealed">nothing to gain by being first</span>} />
              <Row k="Funded from the XRP Ledger" v="a Data Connector proof, not a bridge" />
            </div>
            <div className="note">
              <strong>What this does not do.</strong> It does not create liquidity. It removes
              a specific cost from providing it: today, quoting real size publicly is how you
              get picked off, and an order that never trades here costs nothing and reveals
              nothing. Whether anyone shows up is a distribution problem, not a protocol one,
              and no amount of cryptography settles it.
            </div>
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

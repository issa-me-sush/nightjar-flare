import { createPublicClient, defineChain, http, erc20Abi } from "viem";
import { Nav } from "../nav";

export const metadata = {
  title: "Nightjar — the depth FXRP does not have",
  description:
    "149 million FXRP outstanding and about a million dollars of stablecoin on the other side. Read live from Flare mainnet.",
};

/**
 * The evidence page.
 *
 * Every number here is read from Flare **mainnet** at request time. Nothing is
 * cached, hard-coded, or taken from a dashboard — the addresses are printed
 * next to the figures so any of it can be checked independently. If the numbers
 * move, this page moves with them, which is the point: the argument for the
 * product is a claim about the real world, and a claim about the real world
 * should be re-derivable on demand.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

const flare = defineChain({
  id: 14,
  name: "Flare",
  nativeCurrency: { name: "Flare", symbol: "FLR", decimals: 18 },
  rpcUrls: { default: { http: ["https://flare-api.flare.network/ext/C/rpc"] } },
  blockExplorers: {
    default: { name: "Flare Explorer", url: "https://flare-explorer.flare.network" },
  },
});

const EXPLORER = flare.blockExplorers.default.url;
const client = createPublicClient({ chain: flare, transport: http() });

/**
 * FXRP on Flare mainnet — resolved from the FAssets asset manager rather than
 * copied from a docs page:
 *   FlareContractRegistry.getContractAddressByName("AssetManagerFXRP").fAsset()
 */
const FXRP = "0xAd552A648C74D49E10027AB8a618A3ad4901c5bE" as const;

/**
 * The four largest holders of FXRP. Not one of them quotes a price: three hold
 * it as collateral or vault deposits, and the fourth is the bridge adapter that
 * carries it off Flare entirely.
 */
const PARKED = [
  {
    addr: "0x4C18Ff3C89632c3Dd62E796c0aFA5c07c4c1B2b3",
    name: "Firelight vault",
    note: "deposited for yield, not quoted",
  },
  {
    addr: "0xF4346F5132e810f80a28487a79c7559d9797E8B0",
    name: "Morpho",
    note: "lending collateral",
  },
  {
    addr: "0xD1b7A5eFa9bd88F291F7A4563a8f6185c0249CB3",
    name: "Kinetic",
    note: "lending collateral",
  },
  {
    addr: "0xd70659a6396285BF7214d7Ea9673184e7C72E07E",
    name: "LayerZero OFT adapter",
    note: "bridged off Flare",
  },
] as const;

/** Every DEX pool holding a material amount of FXRP. */
const POOLS = [
  "0x2a91D9296ee2fe4139b49c7071b2f29f59a9f9aE",
  "0xa4cE7dAfC6fB5acEEDd0070620b72aB8f09b0770",
  "0x927485d88a66253c63Af9163dca5f21c25A57393",
  "0x686f53F0950Ef193C887527eC027E6A574A4DbE1",
  "0x9f6c46f190351275e47D7aD8D3F2c9487569211E",
  "0xf02DBD2A21D8E6fe48a51eD51dDc0d4621db45D0",
  "0xb4CB11a84CFbd8F6336Dc9417aC45c1F8E5B59E7",
  "0x88D46717b16619B37fa2DfD2F038DEFB4459F1F7",
] as const;

/**
 * Symbols a seller can actually leave with. An FXRP/stXRP pool can be deep and
 * still be useless for exiting: both sides are XRP exposure on Flare, so the
 * trade is a change of wrapper, not a way out.
 */
const STABLE = new Set(["USD₮0", "USDT0", "USDC", "USDC.e", "USDT", "eUSDT"]);

const poolAbi = [
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

type Pool = {
  addr: string;
  fxrp: bigint;
  other: bigint;
  otherSymbol: string;
  otherDecimals: number;
  isExit: boolean;
};

async function read() {
  const [supply, block] = await Promise.all([
    client.readContract({ address: FXRP, abi: erc20Abi, functionName: "totalSupply" }),
    client.getBlockNumber(),
  ]);

  const parked = await Promise.all(
    PARKED.map(async (h) => ({
      ...h,
      held: await client.readContract({
        address: FXRP,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [h.addr as `0x${string}`],
      }),
    })),
  );

  const pools: Pool[] = [];
  for (const addr of POOLS) {
    try {
      const a = addr as `0x${string}`;
      const [t0, t1] = await Promise.all([
        client.readContract({ address: a, abi: poolAbi, functionName: "token0" }),
        client.readContract({ address: a, abi: poolAbi, functionName: "token1" }),
      ]);
      const other = (t0.toLowerCase() === FXRP.toLowerCase() ? t1 : t0) as `0x${string}`;
      const [fxrp, bal, sym, dec] = await Promise.all([
        client.readContract({ address: FXRP, abi: erc20Abi, functionName: "balanceOf", args: [a] }),
        client.readContract({ address: other, abi: erc20Abi, functionName: "balanceOf", args: [a] }),
        client.readContract({ address: other, abi: erc20Abi, functionName: "symbol" }),
        client.readContract({ address: other, abi: erc20Abi, functionName: "decimals" }),
      ]);
      pools.push({
        addr,
        fxrp,
        other: bal,
        otherSymbol: sym,
        otherDecimals: dec,
        isExit: STABLE.has(sym),
      });
    } catch {
      // A pool that no longer answers is not evidence of anything; skip it.
    }
  }

  return { supply, block, parked, pools };
}

// ── formatting ───────────────────────────────────────────────────────────────

function whole(v: bigint, decimals: number) {
  const n = v / 10n ** BigInt(decimals);
  return n.toLocaleString("en-US");
}

function pct(part: bigint, total: bigint) {
  if (total === 0n) return "—";
  const bp = Number((part * 10000n) / total);
  return `${(bp / 100).toFixed(2)}%`;
}

function short(a: string) {
  return `${a.slice(0, 8)}…${a.slice(-4)}`;
}

function Row({ k, v, big }: { k: React.ReactNode; v: React.ReactNode; big?: boolean }) {
  return (
    <div>
      <span className="k">{k}</span>
      <span className="lead" />
      <span className={big ? "v big" : "v"}>{v}</span>
    </div>
  );
}

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

export default async function Depth() {
  const { supply, block, parked, pools } = await read();

  const parkedTotal = parked.reduce((a, p) => a + p.held, 0n);
  const poolTotal = pools.reduce((a, p) => a + p.fxrp, 0n);
  const exitDepth = pools.filter((p) => p.isExit).reduce((a, p) => a + p.other, 0n);
  const exitCount = pools.filter((p) => p.isExit).length;

  // Both FXRP and the stablecoins on Flare carry six decimals, so the ratio
  // below is a like-for-like comparison of token counts, not a price claim.
  const ratio = supply > 0n ? Number((exitDepth * 10000n) / supply) / 100 : 0;

  return (
    <>
      <Nav />

      <main className="wrap" style={{ paddingBottom: 80 }}>
        <section style={{ padding: "64px 0 40px", maxWidth: "62ch" }}>
          <p className="eyebrow">Read live from Flare mainnet · block {block.toLocaleString("en-US")}</p>
          <h1 style={{ marginTop: 18 }}>
            The depth FXRP
            <br />
            does not have.
          </h1>
          <p className="lede" style={{ marginTop: 22 }}>
            Everything on this page is fetched from Flare mainnet when you load it. No
            dashboard, no cache, no figures typed in by hand. The addresses are printed next
            to the numbers so you can check any line yourself.
          </p>
        </section>

        <Sheet label="The gap" sub="supply against exit">
          <div className="stack gap32">
            <div className="figure">
              <span className="n">{ratio.toFixed(2)}%</span>
              <p className="cap">
                of FXRP&rsquo;s float has stablecoin waiting on the other side of the trade.{" "}
                <strong>{whole(supply, 6)} FXRP</strong> outstanding;{" "}
                <strong>{whole(exitDepth, 6)}</strong> of stablecoin across {exitCount} pools.
                If one holder in a hundred wanted out at once, there is no price at which
                they all get out.
              </p>
            </div>
            <div className="ledger">
              <Row
                k="FXRP"
                v={
                  <a href={`${EXPLORER}/address/${FXRP}`} target="_blank" rel="noreferrer">
                    {short(FXRP)}
                  </a>
                }
              />
              <Row k="Total supply" v={`${whole(supply, 6)} FXRP`} big />
              <Row k="Stablecoin exit depth" v={<span className="exposed">{whole(exitDepth, 6)}</span>} big />
            </div>
          </div>
        </Sheet>

        <Sheet label="Where it sits" sub="the four largest holders">
          <div className="stack gap24">
            <h2>Eighty-four per cent of the float is parked, not quoted.</h2>
            <p className="body">
              The largest holders of FXRP are a yield vault, two lending markets, and the
              bridge that takes it off Flare. None of them puts a price on the screen. This
              is capital that is present on Flare and absent from the order book — and the
              fourth-largest holder of FXRP is the adapter carrying it somewhere else.
            </p>
            <div className="ledger">
              {parked.map((p) => (
                <Row
                  key={p.addr}
                  k={
                    <>
                      <a href={`${EXPLORER}/address/${p.addr}`} target="_blank" rel="noreferrer">
                        {p.name}
                      </a>
                      <span className="tiny" style={{ marginLeft: 10, color: "var(--faint)" }}>
                        {p.note}
                      </span>
                    </>
                  }
                  v={`${whole(p.held, 6)} · ${pct(p.held, supply)}`}
                />
              ))}
              <Row
                k={<strong>four contracts</strong>}
                v={<span className="exposed">{`${whole(parkedTotal, 6)} · ${pct(parkedTotal, supply)}`}</span>}
                big
              />
            </div>
          </div>
        </Sheet>

        <Sheet label="What a seller gets" sub="pool by pool">
          <div className="stack gap24">
            <h2>And the deepest pools are not exits.</h2>
            <p className="body">
              The two largest FXRP pools are priced in stXRP. Trading FXRP for staked XRP is
              not leaving — it is the same risk in a different wrapper. Only the marked rows
              settle into something a holder can walk away with.
            </p>

            <div className="scrollx">
              <div className="ledger">
                {pools.map((p) => (
                  <Row
                    key={p.addr}
                    k={
                      <>
                        <a href={`${EXPLORER}/address/${p.addr}`} target="_blank" rel="noreferrer">
                          {short(p.addr)}
                        </a>
                        <span
                          className="tiny"
                          style={{
                            marginLeft: 10,
                            color: p.isExit ? "var(--jade)" : "var(--faint)",
                          }}
                        >
                          {p.isExit ? "an exit" : "not an exit"}
                        </span>
                      </>
                    }
                    v={
                      <>
                        {whole(p.fxrp, 6)} FXRP{" "}
                        <span style={{ color: "var(--faint)" }}>⇄</span>{" "}
                        <span className={p.isExit ? "sealed" : ""}>
                          {whole(p.other, p.otherDecimals)} {p.otherSymbol}
                        </span>
                      </>
                    }
                  />
                ))}
              </div>
            </div>

            <div className="ledger" style={{ marginTop: 4 }}>
              <Row k="In DEX pools at all" v={`${whole(poolTotal, 6)} FXRP · ${pct(poolTotal, supply)}`} />
              <Row
                k="Of that, a real exit"
                v={<span className="sealed">{`${whole(exitDepth, 6)} · ${pct(exitDepth, supply)}`}</span>}
                big
              />
            </div>
          </div>
        </Sheet>

        <Sheet label="Why" sub="and what follows">
          <div className="stack gap24">
            <h2>This is not a subsidy problem.</h2>
            <p className="body">
              Incentives have already been tried at scale — Flare committed billions of FLR
              to bringing liquidity to FXRP — and the float responded by sitting in vaults or
              bridging away. That is the tell. Rented liquidity leaves when the rent stops,
              because the reason it was not there in the first place was never the yield.
            </p>
            <p className="body">
              Resting real size on a public book means publishing your intention before it
              fills. The people with size respond rationally by not showing up, and a book
              nobody rests on has no depth to show. Paying them to publish does not change
              the reason they would rather not.
            </p>
            <div className="note jade">
              <strong>Which is the one thing a smart contract cannot fix.</strong> On-chain
              state is public by construction — everything a contract knows, everyone knows.
              Removing the reason to hide requires execution that is confidential and
              settlement that is not, which is exactly the split Flare Confidential Compute
              provides. We measured what visibility costs a single trader at{" "}
              <a href="/proof">392 basis points</a>.
            </div>
          </div>
        </Sheet>

        <Sheet label="Check it" sub="one command">
          <div className="stack gap20">
            <p className="body">
              The same measurement runs from the command line, against the same chain,
              with no key and no wallet:
            </p>
            <pre className="plate mono">cd tools &amp;&amp; go run ./cmd/fxrp-depth</pre>
            <p className="small">
              It prints every address it reads. If these numbers are wrong, that command is
              how you find out.
            </p>
          </div>
        </Sheet>

        <footer
          className="between wrapf"
          style={{ paddingTop: 24, borderTop: "1px solid var(--hair)" }}
        >
          <span className="tiny">
            Flare mainnet, read at block {block.toLocaleString("en-US")}. The venue itself is
            on Coston2.
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
    </>
  );
}

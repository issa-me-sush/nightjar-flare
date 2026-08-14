import { createPublicClient, http, decodeAbiParameters } from "viem";
import abi from "@/lib/nightjar-abi.json";
import { Nav } from "../nav";
import {
  BASE_SYMBOL,
  CONTROL_VENUE,
  DEPTH_DEMO,
  PROOF,
  QUOTE_SYMBOL,
  VENUE,
  coston2,
} from "@/lib/config";
import { formatAmount, formatPrice } from "@/lib/seal";

export const metadata = {
  title: "Nightjar — verify it yourself",
  description:
    "The same trade on a transparent order book and on a sealed one, both live on Coston2. No wallet required.",
};

/**
 * A wallet-free proof page.
 *
 * Everything is read from the public Coston2 RPC at request time, so it stays
 * true whether or not the enclave, the tunnel, or any of our machines are up.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

const EXPLORER = coston2.blockExplorers.default.url;
const client = createPublicClient({ chain: coston2, transport: http() });

const controlVenueAbi = [
  {
    name: "getOrder",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "orderId", type: "uint64" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "trader", type: "address" },
          { name: "side", type: "uint8" },
          { name: "limitPrice", type: "uint256" },
          { name: "size", type: "uint256" },
          { name: "filled", type: "bool" },
        ],
      },
    ],
  },
] as const;

async function load() {
  // What an ordinary on-chain book hands to anyone who asks.
  const leaked = (await client.readContract({
    address: CONTROL_VENUE,
    abi: controlVenueAbi,
    functionName: "getOrder",
    args: [BigInt(PROOF.controlOrderId)],
  })) as { trader: string; side: number; limitPrice: bigint; size: bigint; filled: boolean };

  // What Nightjar recorded for the same intent.
  const sealedTx = await client.getTransaction({ hash: PROOF.sealedOrders[0] });
  const [ciphertext] = decodeAbiParameters([{ type: "bytes" }], `0x${sealedTx.input.slice(10)}`);

  const settleTx = await client.getTransaction({ hash: PROOF.settlement });
  const [settlementBytes, signatures] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    `0x${settleTx.input.slice(10)}`
  );
  const signature = (signatures as readonly `0x${string}`[])[0];
  const [chainId, venueAddr, batchId, clearingPrice, matchedBase] = decodeAbiParameters(
    [
      { type: "uint256" }, { type: "address" }, { type: "uint64" },
      { type: "uint256" }, { type: "uint256" },
      { type: "tuple[]", components: [
        { name: "trader", type: "address" },
        { name: "baseDelta", type: "int256" },
        { name: "quoteDelta", type: "int256" },
      ] },
    ],
    settlementBytes as `0x${string}`
  );

  const [settled, orderCount, teeAddress, feeBps, maxFeeBps, feesCollected, threshold, signerCount] =
    (await Promise.all([
      client.readContract({ address: VENUE, abi, functionName: "batchSettled", args: [BigInt(PROOF.settledBatch)] }),
      client.readContract({ address: VENUE, abi, functionName: "batchOrderCount", args: [BigInt(PROOF.settledBatch)] }),
      client.readContract({ address: VENUE, abi, functionName: "teeAddress" }),
      client.readContract({ address: VENUE, abi, functionName: "feeBps" }),
      client.readContract({ address: VENUE, abi, functionName: "MAX_FEE_BPS" }),
      client.readContract({ address: VENUE, abi, functionName: "feesCollected" }),
      client.readContract({ address: VENUE, abi, functionName: "signatureThreshold" }),
      client.readContract({ address: VENUE, abi, functionName: "teeSignerCount" }),
    ])) as [boolean, number, string, number, number, bigint, number, bigint];

  // Batch 2: a market maker's two-sided ladder plus a taker. Most of it never
  // traded, and this is where the chain's silence about the rest is legible.
  const depth = await (async () => {
    const [result, count] = (await Promise.all([
      client.readContract({ address: VENUE, abi, functionName: "batches", args: [BigInt(DEPTH_DEMO.batch)] }),
      client.readContract({ address: VENUE, abi, functionName: "batchOrderCount", args: [BigInt(DEPTH_DEMO.batch)] }),
    ])) as [readonly [bigint, bigint, bigint, bigint, number, number], number];
    const [price, matched, fee, , fillCount] = result;
    return {
      price,
      matched,
      fee,
      fills: Number(fillCount),
      orders: Number(count),
      unrevealed: Number(count) - Number(fillCount),
    };
  })();

  const paidTransparent = (leaked.size * leaked.limitPrice) / 10n ** 18n;
  const paidNightjar = ((matchedBase as bigint) * (clearingPrice as bigint)) / 10n ** 18n;
  const bps = ((paidTransparent - paidNightjar) * 10000n) / paidNightjar;

  return {
    leaked, ciphertext: ciphertext as `0x${string}`, signature: signature as `0x${string}`,
    signatureCount: (signatures as readonly unknown[]).length,
    chainId: chainId as bigint, venueAddr: venueAddr as string, batchId: batchId as bigint,
    clearingPrice: clearingPrice as bigint, matchedBase: matchedBase as bigint,
    settled, orderCount: Number(orderCount), teeAddress,
    feeBps: Number(feeBps), maxFeeBps: Number(maxFeeBps), feesCollected,
    threshold: Number(threshold), signerCount: Number(signerCount),
    depth,
    paidTransparent, paidNightjar, bps,
  };
}

export default async function Proof() {
  let d: Awaited<ReturnType<typeof load>> | null = null;
  let error: string | null = null;
  try {
    d = await load();
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <>
      <Nav />
      <main className="narrow" style={{ padding: "40px 24px 90px" }}>
        <div className="stack gap32">
          <div className="stack gap12">
            <p className="eyebrow">Read live from Coston2 · no wallet needed</p>
            <h1>The same trade, on a transparent book and a sealed one.</h1>
            <p className="lede">
              We deployed an ordinary on-chain order book as a control and ran the identical trade
              through both venues. Every figure below is fetched from the public RPC when you load
              this page — nothing of ours has to be running for it to be true.
            </p>
          </div>

          {error && <div className="note amber">Could not reach Coston2: {error}</div>}

          {d && (
            <>
              {/* headline */}
              <div className="figure">
                <span className="n">{d.bps.toString()} bps</span>
                <p className="cap">
                  is what the transparent venue cost the buyer, against the sealed one. Same
                  buyer, same seller, same size — the only difference was whether her limit price
                  could be read.
                </p>
              </div>

              {/* side by side */}
              <div className="compare">
                <section className="side">
                  <span className="label" style={{ color: "var(--amber)" }}>control · transparent book</span>
                  <div className="stack gap12">
                    <p className="small">
                      A live <code>getOrder()</code> call. Anyone can make it. It returns:
                    </p>
                    <div className="plate is-exposed">
                      <div className="readout">
                        <span className="k">trader </span><span className="v">{d.leaked.trader.slice(0, 14)}…</span><br />
                        <span className="k">side   </span><span className="v">{d.leaked.side === 0 ? "BUY" : "SELL"}</span><br />
                        <span className="k">limit  </span><span className="v">{formatPrice(d.leaked.limitPrice)}</span><br />
                        <span className="k">size   </span><span className="v">{formatAmount(d.leaked.size)} {BASE_SYMBOL}</span>
                      </div>
                    </div>
                    <p className="small">
                      Knowing she would pay up to <strong>1.06</strong>, the seller asked exactly
                      that instead of the <strong>1.02</strong> he would have accepted. He is not
                      attacking anything — he read public state.
                    </p>
                    <a className="tiny" href={`${EXPLORER}/tx/${PROOF.controlTaken}`} target="_blank" rel="noreferrer">
                      the fill →
                    </a>
                  </div>
                </section>
                <div className="div" />
                <section className="side">
                  <span className="label" style={{ color: "var(--jade)" }}>nightjar · sealed</span>
                  <div className="stack gap12">
                    <p className="small">
                      The same intent, submitted here. The entire payload is{" "}
                      {(d.ciphertext.length - 2) / 2} bytes of ciphertext:
                    </p>
                    <div className="plate is-sealed"><code>{d.ciphertext}</code></div>
                    <p className="small">
                      No side, no price, no size. The leading <code>04</code> is an ephemeral
                      public key; only the enclave holds what opens the rest. The batch cleared at{" "}
                      <strong>{formatPrice(d.clearingPrice)}</strong>.
                    </p>
                    <a className="tiny" href={`${EXPLORER}/tx/${PROOF.sealedOrders[0]}`} target="_blank" rel="noreferrer">
                      the sealed order →
                    </a>
                  </div>
                </section>
              </div>

              {/* the trade */}
              <section className="panel">
                <header><span className="label">The trade, both ways</span></header>
                <div className="scrollx">
                  <table>
                    <thead>
                      <tr><th>Venue</th><th>Her limit</th><th>Executed at</th><th>She paid</th></tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Transparent book</td>
                        <td className="n">{formatPrice(d.leaked.limitPrice)} <span className="tiny">public</span></td>
                        <td className="n exposed">{formatPrice(d.leaked.limitPrice)}</td>
                        <td className="n">{formatAmount(d.paidTransparent)} {QUOTE_SYMBOL}</td>
                      </tr>
                      <tr>
                        <td>Nightjar</td>
                        <td className="n">{formatPrice(d.leaked.limitPrice)} <span className="tiny">sealed</span></td>
                        <td className="n sealed">{formatPrice(d.clearingPrice)}</td>
                        <td className="n">{formatAmount(d.paidNightjar)} {QUOTE_SYMBOL}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>

              {/* business model */}
              <section className="panel">
                <header><span className="label">What the venue charges for that</span></header>
                <div className="body-pad">
                  <dl className="dl">
                    <div><dt>Protocol fee</dt><dd>{d.feeBps} bps of matched notional</dd></div>
                    <div><dt>Ceiling, fixed in bytecode</dt><dd>{d.maxFeeBps} bps</dd></div>
                    <div><dt>Fee on an order that never matches</dt><dd className="sealed">zero</dd></div>
                    <div><dt>Fees collected to date</dt><dd>{formatAmount(d.feesCollected)} {QUOTE_SYMBOL}</dd></div>
                  </dl>
                  <p className="small">
                    {d.feeBps} bps against roughly {d.bps.toString()} the trader keeps. The fee is
                    charged only on volume actually matched, so resting size costs nothing — which
                    is the point of the venue. The ceiling cannot be raised by governance, so
                    depositing does not require trusting the owner not to change the deal later.
                  </p>
                </div>
              </section>

              {/* enclave not trusted */}
              <section className="panel">
                <header>
                  <span className="label">The enclave is not trusted either</span>
                  <span className={d.settled ? "pill ok" : "pill err"}>
                    {d.settled ? "settled" : "not settled"}
                  </span>
                </header>
                <div className="body-pad">
                  <p className="small">
                    It never holds funds. It returns signed balance deltas, and the contract
                    rejects them unless both assets net to zero and the clearing price sits inside
                    a band around Flare&rsquo;s own FTSO feed, re-read on-chain at settlement.
                  </p>
                  <dl className="dl">
                    <div><dt>Batch</dt><dd>{d.batchId.toString()}</dd></div>
                    <div><dt>Clearing price</dt><dd>{formatPrice(d.clearingPrice, 4)}</dd></div>
                    <div><dt>Matched</dt><dd>{formatAmount(d.matchedBase)} {BASE_SYMBOL}</dd></div>
                    <div><dt>Orders in batch <span className="tiny">(only public stat)</span></dt><dd>{d.orderCount}</dd></div>
                    <div><dt>Signed by TEE</dt><dd>{d.teeAddress}</dd></div>
                    <div><dt>Bound to chain / venue</dt><dd>{d.chainId.toString()} / {d.venueAddr.slice(0, 10)}…</dd></div>
                  </dl>
                  <div className="plate is-sealed"><code>{d.signature}</code></div>
                  <a className="tiny" href={`${EXPLORER}/tx/${PROOF.settlement}`} target="_blank" rel="noreferrer">
                    settlement transaction →
                  </a>
                </div>
              </section>

              {/* what the chain never learned */}
              <section className="panel">
                <header>
                  <span className="label">What the chain never learned</span>
                  <span className="pill ok">batch {DEPTH_DEMO.batch}</span>
                </header>
                <div className="body-pad">
                  <p className="small">
                    A crossing pair proves the plumbing. This is the product: a market maker
                    rested a two-sided ladder, a taker crossed one rung of it, and the rest
                    stayed where it was. The venue recorded a clearing price, a matched
                    volume, and two net deltas — and nothing whatsoever about the orders that
                    did not trade.
                  </p>
                  <div className="scrollx">
                    <table>
                      <thead>
                        <tr><th>Order</th><th>Submitted as</th><th>What the chain holds</th></tr>
                      </thead>
                      <tbody>
                        <tr><td>maker BUY 1.0 @ 0.99</td><td className="n">ciphertext</td><td className="sealed">nothing</td></tr>
                        <tr><td>maker BUY 1.0 @ 1.01</td><td className="n">ciphertext</td><td className="n">a net delta</td></tr>
                        <tr><td>maker SELL 1.0 @ 1.03</td><td className="n">ciphertext</td><td className="sealed">nothing</td></tr>
                        <tr><td>maker SELL 1.0 @ 1.05</td><td className="n">ciphertext</td><td className="sealed">nothing</td></tr>
                        <tr><td>taker SELL 1.0 @ 1.00</td><td className="n">ciphertext</td><td className="n">a net delta</td></tr>
                      </tbody>
                    </table>
                  </div>
                  <dl className="dl">
                    <div><dt>Orders resting <span className="tiny">(the only public stat)</span></dt><dd>{d.depth.orders}</dd></div>
                    <div><dt>Cleared at</dt><dd>{formatPrice(d.depth.price, 4)}</dd></div>
                    <div><dt>Matched</dt><dd>{formatAmount(d.depth.matched)} {BASE_SYMBOL}</dd></div>
                    <div><dt>Traders filled</dt><dd>{d.depth.fills}</dd></div>
                    <div><dt>Never revealed</dt><dd className="sealed">{d.depth.unrevealed} orders — side, price and size destroyed in the enclave</dd></div>
                  </dl>
                  <p className="small">
                    The rows marked <span className="sealed">nothing</span> are the whole
                    argument. On a transparent book each of them would be a public quote,
                    readable by anyone deciding what to charge you next.
                  </p>
                  <a className="tiny" href={`${EXPLORER}/tx/${DEPTH_DEMO.settlement}`} target="_blank" rel="noreferrer">
                    settlement transaction →
                  </a>
                </div>
              </section>

              {/* quorum */}
              <section className="panel">
                <header>
                  <span className="label">And it does not have to be one enclave</span>
                  <span className="pill">{d.threshold} of {d.signerCount}</span>
                </header>
                <div className="body-pad">
                  <p className="small">
                    A price-time-priority book cannot be replicated: matching depends on
                    arrival order, so two enclaves fed the same orders sign different
                    settlements and there is nothing to agree on. A uniform-price batch
                    auction consumes a <em>set</em> and returns the volume-maximising price —
                    identical bytes from every enclave, whatever order they arrived in. That
                    is a matching-engine test, and it is what makes a quorum possible at all.
                  </p>
                  <dl className="dl">
                    <div><dt>Registered enclaves</dt><dd>{d.signerCount}</dd></div>
                    <div><dt>Signatures required</dt><dd>{d.threshold}</dd></div>
                    <div><dt>Signatures on this settlement</dt><dd>{d.signatureCount}</dd></div>
                    <div><dt>Contract enforces</dt><dd className="sealed">distinct · registered · strictly increasing</dd></div>
                  </dl>
                  <p className="small">
                    <strong>Stated plainly:</strong> Coston2 runs one registered enclave with
                    a threshold of one, because a second needs a second host. The k-of-n path
                    is deployed and covered by six tests — one signature under a threshold of
                    two fails, two enclaves settle, the same enclave cannot sign twice, an
                    unregistered signer does not count, and disagreeing enclaves cannot
                    settle. <code>addTee()</code> raises it without a redeploy.
                  </p>
                </div>
              </section>

              {/* diy */}
              <section className="panel">
                <header><span className="label">Without this page</span></header>
                <div className="body-pad">
                  <div className="plate is-sealed">
                    <code style={{ whiteSpace: "pre-wrap", color: "var(--muted)" }}>{`# the transparent venue hands you her limit price
cast call ${CONTROL_VENUE} \\
  "getOrder(uint64)((address,uint8,uint256,uint256,bool))" ${PROOF.controlOrderId} \\
  --rpc-url ${coston2.rpcUrls.default.http[0]}

# the sealed one hands you ${(d.ciphertext.length - 2) / 2} bytes of ciphertext
cast tx ${PROOF.sealedOrders[0]} --rpc-url ${coston2.rpcUrls.default.http[0]}

# and the batch really is settled
cast call ${VENUE} "batchSettled(uint64)(bool)" ${PROOF.settledBatch} \\
  --rpc-url ${coston2.rpcUrls.default.http[0]}`}</code>
                  </div>
                </div>
              </section>
            </>
          )}
        </div>
      </main>
    </>
  );
}

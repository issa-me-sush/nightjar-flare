"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Address } from "viem";
import abi from "@/lib/nightjar-abi.json";
import { Nav } from "../nav";
import {
  BASE_SYMBOL,
  BASE_TOKEN,
  DECIMALS,
  INSTRUCTION_FEE,
  QUOTE_SYMBOL,
  QUOTE_TOKEN,
  VENUE,
  XRPL_DESK_ACCOUNT,
  XRPL_EXPLORER,
  coston2,
} from "@/lib/config";
import * as journal from "@/lib/journal";
import {
  formatAmount,
  formatPrice,
  parseAmount,
  parsePrice,
  sealOrder,
  type OrderTerms,
} from "@/lib/seal";
import {
  b64ToHex,
  erc20Abi,
  explain,
  getWallet,
  instructionIdFrom,
  pollSettlement,
  publicClient,
  readBalances,
  readHistory,
  readOraclePrice,
  readVenue,
  type BatchRecord,
  type Balances,
  type Settlement,
  type VenueState,
} from "@/lib/venue";

const EXPLORER = coston2.blockExplorers.default.url;

/**
 * What the trader is doing, as they experience it. The protocol has more steps
 * than this; they are not the trader's problem.
 */
type Stage = "idle" | "sealing" | "submitting" | "resting" | "matching" | "filled";

type Entry = { kind: "ok" | "err" | "info"; msg: string; tx?: string; at: string };

export default function Terminal() {
  const [account, setAccount] = useState<Address | null>(null);
  const [tee, setTee] = useState<{ publicKey?: `0x${string}`; codeHash?: string; error?: string }>({});
  const [venue, setVenue] = useState<VenueState | null>(null);
  const [bal, setBal] = useState<Balances | null>(null);
  const [oracle, setOracle] = useState<bigint | null>(null);
  const [history, setHistory] = useState<BatchRecord[]>([]);
  const [feed, setFeed] = useState<Entry[]>([]);

  const [side, setSide] = useState<0 | 1>(0);
  const [limit, setLimit] = useState("1.05");
  const [size, setSize] = useState("2");

  const [depBase, setDepBase] = useState("2");
  const [depQuote, setDepQuote] = useState("25");
  const [showFunding, setShowFunding] = useState(false);
  const [showOperator, setShowOperator] = useState(false);

  // The XRP Ledger door. `xrplStage` is what the payer sees; the protocol has
  // more steps than this and they are not the payer's problem.
  const [xrplTx, setXrplTx] = useState("");
  const [xrplStage, setXrplStage] = useState<
    "idle" | "attesting" | "waiting" | "crediting" | "done"
  >("idle");
  const [xrplNote, setXrplNote] = useState<string | null>(null);
  const [xrplResult, setXrplResult] = useState<{ tx?: string; drops?: string } | null>(null);

  /** Your own orders. Nobody else can hold this record — see lib/journal.ts. */
  const [orders, setOrders] = useState<journal.JournalEntry[]>([]);

  const [stage, setStage] = useState<Stage>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [sealedPreview, setSealedPreview] = useState<`0x${string}` | null>(null);
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const say = useCallback((kind: Entry["kind"], msg: string, tx?: string) => {
    const at = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setFeed((f) => [{ kind, msg, tx, at }, ...f].slice(0, 24));
  }, []);

  const refresh = useCallback(async (who: Address | null) => {
    try {
      const v = await readVenue();
      setVenue(v);
      setOracle(await readOraclePrice());
      setHistory(await readHistory(v.batchId));
      if (who) setBal(await readBalances(who));
    } catch {
      /* transient RPC hiccups should not blank the screen */
    }
  }, []);

  useEffect(() => {
    fetch("/api/tee").then((r) => r.json()).then(setTee).catch((e) => setTee({ error: String(e) }));
    void refresh(null);
  }, [refresh]);

  useEffect(() => {
    if (!account) return;
    void refresh(account);
    const t = setInterval(() => void refresh(account), 12_000);
    return () => clearInterval(t);
  }, [account, refresh]);

  useEffect(() => {
    setOrders(journal.forAccount(account));
  }, [account]);

  // A batch that has settled resolves whatever was resting in it.
  useEffect(() => {
    if (history.length === 0) return;
    journal.reconcile(
      history.map((h) => ({ id: h.id, matchedBase: h.matchedBase, clearingPrice: h.clearingPrice }))
    );
    setOrders(journal.forAccount(account));
  }, [history, account]);

  // Your order is resting for as long as the venue holds your balance locked.
  useEffect(() => {
    if (!bal || !venue) return;
    const locked = bal.lockedInBatch !== 0n && bal.lockedInBatch >= venue.batchId;
    if (locked && stage === "idle") setStage("resting");
    if (!locked && stage === "resting") setStage("idle");
  }, [bal, venue, stage]);

  async function connect() {
    try {
      const w = await getWallet();
      const [addr] = await w.requestAddresses();
      try {
        await w.switchChain({ id: coston2.id });
      } catch {
        await w.addChain({ chain: coston2 });
      }
      setAccount(addr);
      say("ok", `Connected ${addr.slice(0, 6)}…${addr.slice(-4)}`);
    } catch (e) {
      say("err", explain(e));
    }
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      say("err", `${label}: ${explain(e)}`);
      setStage("idle");
      setNote(null);
    } finally {
      setBusy(null);
      void refresh(account);
    }
  }

  // ── arriving from the XRP Ledger ─────────────────────────────────────

  /**
   * The payer has already sent XRP. Everything from here is Flare's Data
   * Connector attesting it and the gateway verifying that attestation — which
   * takes a couple of minutes because a voting round has to finalise. The
   * relayer pays the fees, because someone arriving from the XRPL has no FLR
   * yet, and it cannot redirect the money: the proof names its own beneficiary.
   */
  async function claimFromXrpl() {
    const tx = xrplTx.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) {
      setXrplNote("That does not look like an XRPL transaction hash.");
      return;
    }
    setXrplResult(null);
    setXrplStage("attesting");
    setXrplNote("Asking Flare's validators to attest your payment…");

    try {
      const started = await fetch("/api/xrpl/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txId: tx.toLowerCase() }),
      }).then((r) => r.json());
      if (started.error) throw new Error(started.error);

      setXrplStage("waiting");
      setXrplNote("Attested. Waiting for the voting round to finalise — about two minutes.");

      // Poll until the round finalises. The window is a couple of minutes, so
      // this is patient rather than fast.
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 15_000));
        const out = await fetch("/api/xrpl/settle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ votingRound: started.votingRound, requestBytes: started.requestBytes }),
        }).then((r) => r.json());

        if (out.pending) {
          setXrplNote(`Waiting for round ${started.votingRound} to finalise… (${i + 1})`);
          continue;
        }
        if (out.error) throw new Error(out.error);

        setXrplStage("done");
        const xrp = out.drops ? (Number(out.drops) / 1e6).toFixed(6) : "";
        if (out.alreadyClaimed) {
          setXrplNote(`Already credited — ${xrp} XRP went to ${out.beneficiary.slice(0, 10)}…`);
        } else {
          setXrplResult({ tx: out.tx, drops: out.drops });
          setXrplNote(null);
          say("ok", `${xrp} XRP arrived from the XRP Ledger`, out.tx);
          void refresh(account);
        }
        return;
      }
      throw new Error("The voting round did not finalise in time. Your payment is safe — try again.");
    } catch (e) {
      setXrplStage("idle");
      setXrplNote(explain(e));
    }
  }

  // ── derived ──────────────────────────────────────────────────────────

  const notional = useMemo(() => {
    try {
      return (parseAmount(size, DECIMALS) * parsePrice(limit)) / 10n ** 18n;
    } catch {
      return null;
    }
  }, [size, limit]);

  const fee = useMemo(
    () => (notional !== null && venue ? (notional * BigInt(venue.feeBps)) / 10000n : null),
    [notional, venue]
  );

  const band = useMemo(() => {
    if (!oracle || !venue) return null;
    return {
      lo: (oracle * BigInt(10000 - venue.maxDeviationBps)) / 10000n,
      hi: (oracle * BigInt(10000 + venue.maxDeviationBps)) / 10000n,
    };
  }, [oracle, venue]);

  const affordable = useMemo(() => {
    if (!bal || notional === null) return true;
    try {
      return side === 0 ? bal.venueQuote >= notional : bal.venueBase >= parseAmount(size, DECIMALS);
    } catch {
      return true;
    }
  }, [bal, notional, side, size]);

  const outOfBand = useMemo(() => {
    if (!band) return false;
    try {
      const p = parsePrice(limit);
      return p < band.lo || p > band.hi;
    } catch {
      return false;
    }
  }, [band, limit]);

  const canPlace = !!account && !busy && stage === "idle" && affordable && !!tee.publicKey;

  // ── the one action a trader takes ────────────────────────────────────

  async function placeOrder() {
    if (!tee.publicKey || !account) throw new Error("Connect a wallet first.");

    setStage("sealing");
    setNote("Encrypting your order in this browser…");
    const terms: OrderTerms = {
      trader: account,
      side,
      limitPrice: parsePrice(limit).toString(),
      size: parseAmount(size, DECIMALS).toString(),
      nonce: String(Date.now()),
    };
    const ct = await sealOrder(tee.publicKey, terms);
    setSealedPreview(ct);
    say("info", `Sealed ${(ct.length - 2) / 2} bytes — this is all the chain will see`);

    setStage("submitting");
    setNote("Submitting. The venue receives ciphertext and nothing else.");
    const w = await getWallet();
    const hash = await w.writeContract({
      account, address: VENUE, abi,
      functionName: "submitOrder", args: [ct],
      value: INSTRUCTION_FEE, gas: 1_500_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash });

    setStage("resting");
    setNote(null);
    say("ok", "Order resting — nobody can see its terms", hash);

    // The chain will not remember these terms and neither will the enclave once
    // the batch clears, so this is the only copy that survives.
    journal.record({
      account, batchId: Number(venue?.batchId ?? 0n), side,
      limit, size, tx: hash, at: Date.now(),
    });
    setOrders(journal.forAccount(account));
  }

  // ── what a keeper does in production ─────────────────────────────────

  async function clearBatch() {
    abort.current = new AbortController();
    const w = await getWallet();
    const hash = await w.writeContract({
      account: account!, address: VENUE, abi,
      functionName: "runBatch", args: [],
      value: INSTRUCTION_FEE, gas: 1_500_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const id = instructionIdFrom(receipt.logs);
    if (!id) throw new Error("no instruction found in the receipt");

    setStage("matching");
    say("info", "Batch dispatched — the enclave is matching", hash);

    try {
      const s = await pollSettlement(
        id,
        (secs) => setNote(`Matching inside the enclave… ${secs}s`),
        abort.current.signal
      );
      setSettlement(s);
      setStage("filled");
      setNote(null);
      say(
        "ok",
        `Cleared at ${formatPrice(BigInt(s.clearingPrice))} — ${formatAmount(BigInt(s.matchedBase))} ${BASE_SYMBOL} matched, ${s.unmatched} never revealed`
      );
    } catch (e) {
      setStage("resting");
      setNote(null);
      throw e;
    }
  }

  async function settle() {
    const w = await getWallet();
    const hash = await w.writeContract({
      account: account!, address: VENUE, abi,
      functionName: "settle",
      // The venue takes a quorum of enclave signatures, so this is a list even
      // when the threshold is one. Sending a bare `bytes` silently fails to
      // encode against the ABI.
      args: [b64ToHex(settlement!.settlement), [b64ToHex(settlement!.signature)]],
      gas: 1_500_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    say("ok", "Settled on-chain — balances updated", hash);
    setSettlement(null);
    setSealedPreview(null);
    setStage("idle");
  }

  async function deposit() {
    const b = parseAmount(depBase, DECIMALS);
    const q = parseAmount(depQuote, DECIMALS);
    if (b === 0n && q === 0n) throw new Error("Enter an amount.");
    const w = await getWallet();
    for (const [token, amount, sym] of [
      [BASE_TOKEN, b, BASE_SYMBOL],
      [QUOTE_TOKEN, q, QUOTE_SYMBOL],
    ] as const) {
      if (amount === 0n) continue;
      const allowance = (await publicClient.readContract({
        address: token, abi: erc20Abi, functionName: "allowance", args: [account!, VENUE],
      })) as bigint;
      if (allowance < amount) {
        const h = await w.writeContract({
          account: account!, address: token, abi: erc20Abi,
          functionName: "approve", args: [VENUE, amount],
        });
        await publicClient.waitForTransactionReceipt({ hash: h });
        say("info", `Approved ${sym}`);
      }
    }
    const hash = await w.writeContract({
      account: account!, address: VENUE, abi, functionName: "deposit", args: [b, q],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    say("ok", `Deposited ${formatAmount(b)} ${BASE_SYMBOL} · ${formatAmount(q)} ${QUOTE_SYMBOL}`, hash);
  }

  async function withdraw() {
    const w = await getWallet();
    const hash = await w.writeContract({
      account: account!, address: VENUE, abi, functionName: "withdraw",
      args: [parseAmount(depBase, DECIMALS), parseAmount(depQuote, DECIMALS)],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    say("ok", "Withdrawn", hash);
  }

  async function faucet() {
    const w = await getWallet();
    const hash = await w.writeContract({
      account: account!, address: QUOTE_TOKEN, abi: erc20Abi,
      functionName: "mint", args: [account!, parseAmount("500", DECIMALS)],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    say("ok", `Minted 500 test ${QUOTE_SYMBOL}`, hash);
  }

  // ── render ───────────────────────────────────────────────────────────

  const stat = (k: string, v: React.ReactNode, tone?: string) => (
    <div className="stat" key={k}>
      <span className="k">{k}</span>
      <span className={tone ? `v ${tone}` : "v"}>{v}</span>
    </div>
  );

  return (
    <>
      <Nav
        right={
          <div className="row gap12">
            {tee.error ? (
              <span className="pill err">enclave offline</span>
            ) : tee.publicKey ? (
              <span className="pill sealed" title={tee.codeHash ?? ""}>
                <span className="dot live" />
                enclave live
              </span>
            ) : (
              <span className="pill">connecting…</span>
            )}
            {account ? (
              <span className="pill mono">
                {account.slice(0, 6)}…{account.slice(-4)}
              </span>
            ) : (
              <button className="primary" onClick={connect}>
                Connect wallet
              </button>
            )}
          </div>
        }
      />

      {/* market strip — inline and divided, not a grid of cards */}
      <div className="strip">
        <div className="wrap row wrapf" style={{ gap: 0 }}>
          {stat("Market", `${BASE_SYMBOL}/${QUOTE_SYMBOL}`)}
          {stat("FTSO XRP/USD", oracle ? formatPrice(oracle, 4) : "—")}
          {stat("Batch", venue ? `#${venue.batchId}` : "—")}
          {stat("Resting", venue ? venue.orderCount : "—")}
          {stat("Book", "sealed", "sealed")}
          {stat("Fee", venue ? `${venue.feeBps} bps` : "—")}
        </div>
      </div>

      <main className="wrap" style={{ paddingTop: 26, paddingBottom: 90 }}>
        {!account && (
          <div className="note" style={{ marginBottom: 22 }}>
            <strong>Connect a wallet on Coston2 to trade.</strong> The venue&rsquo;s live state is
            readable without one, and the <a href="/proof">proof page</a> needs no wallet at all.
          </div>
        )}

        <div className="deck">
          {/* ── what is happening to your order ────────────────────────── */}
          <div className="stack gap32">
            <section className="stack gap16">
              <div className="between">
                <h2 style={{ fontSize: 21 }}>
                  {stage === "idle" && "Place an order"}
                  {stage === "sealing" && "Sealing"}
                  {stage === "submitting" && "Submitting"}
                  {stage === "resting" && "Your order is resting"}
                  {stage === "matching" && "Matching"}
                  {stage === "filled" && "Batch cleared"}
                </h2>
                <span className={stage === "resting" || stage === "filled" ? "pill sealed" : "pill"}>
                  {stage === "idle" ? "no order" : stage}
                </span>
              </div>

              {note && <p className="small">{note}</p>}

              {stage === "idle" && (
                <p className="body">
                  Your order is encrypted in this browser before it is sent. The venue stores
                  ciphertext and one public number — how many orders are in the batch. Nobody,
                  including us, can read your side, price or size until the batch clears.
                </p>
              )}

              {stage === "resting" && (
                <>
                  <p className="body">
                    It sits in the enclave with the rest of the book. There is nothing to watch:
                    when the batch clears, everyone in it trades at a single price, so there is no
                    advantage to being early and nothing to sandwich.
                  </p>
                  <div className="note">
                    Even we cannot tell you what you ordered. Only the enclave can open it — and if
                    it does not trade, those terms are destroyed and never published.
                  </div>
                </>
              )}

              {sealedPreview &&
                (stage === "sealing" || stage === "submitting" || stage === "resting") && (
                  <div className="plate is-sealed">
                    <div className="between">
                      <span className="label" style={{ color: "var(--jade)" }}>
                        what the chain sees · {(sealedPreview.length - 2) / 2} bytes
                      </span>
                      <span className="tiny mono">04 ‖ key ‖ IV ‖ ct ‖ MAC</span>
                    </div>
                    <code>{sealedPreview}</code>
                  </div>
                )}

              {stage === "filled" && settlement && (
                <>
                  <div className="ledger">
                    <div>
                      <span className="k">Cleared at</span>
                      <span className="lead" />
                      <span className="v big sealed">
                        {formatPrice(BigInt(settlement.clearingPrice))}
                      </span>
                    </div>
                    <div>
                      <span className="k">Matched</span>
                      <span className="lead" />
                      <span className="v">
                        {formatAmount(BigInt(settlement.matchedBase))} {BASE_SYMBOL}
                      </span>
                    </div>
                    <div>
                      <span className="k">Orders that never traded</span>
                      <span className="lead" />
                      <span className="v sealed">{settlement.unmatched} · never revealed</span>
                    </div>
                  </div>
                  <p className="small">
                    Submitting this settlement makes the chain check it independently: the
                    signature must match the registered enclave, the price must sit inside the FTSO
                    band, and both assets must net to zero.
                  </p>
                  <button className="primary wide" disabled={!!busy} onClick={() => run("settling", settle)}>
                    Settle on-chain
                  </button>
                </>
              )}
            </section>

            <section className="stack gap12">
              <div className="between">
                <span className="label">Settled batches</span>
                <span className="tiny">from contract storage · no indexer</span>
              </div>
              {history.length === 0 ? (
                <p className="empty">No batches settled yet.</p>
              ) : (
                <div className="scrollx">
                  <table>
                    <thead>
                      <tr>
                        <th>Batch</th>
                        <th>Cleared</th>
                        <th>Matched</th>
                        <th>Orders</th>
                        <th>Fee</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((b) => (
                        <tr key={b.id}>
                          <td className="n">#{b.id}</td>
                          <td className="n">
                            {b.clearingPrice === 0n ? (
                              <span className="tiny">abandoned</span>
                            ) : (
                              formatPrice(b.clearingPrice)
                            )}
                          </td>
                          <td className="n">{formatAmount(b.matchedBase)}</td>
                          <td className="n">{b.orderCount}</td>
                          <td className="n">{formatAmount(b.feeCharged, DECIMALS, 6)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {orders.length > 0 && (
              <section className="stack gap12">
                <div className="between">
                  <span className="label">Your orders</span>
                  <button
                    className="linky tiny"
                    onClick={() => { journal.clear(); setOrders([]); }}
                  >
                    forget
                  </button>
                </div>
                <div className="scrollx">
                  <table>
                    <thead>
                      <tr><th>Batch</th><th>Side</th><th>Limit</th><th>Size</th><th>Outcome</th><th /></tr>
                    </thead>
                    <tbody>
                      {orders.slice(0, 8).map((o, i) => (
                        <tr key={i}>
                          <td className="n">#{o.batchId}</td>
                          <td className="n">{o.side === 0 ? "BUY" : "SELL"}</td>
                          <td className="n">{o.limit}</td>
                          <td className="n">{o.size}</td>
                          <td className="n">
                            {o.outcome === "matched" ? (
                              <span className="sealed">
                                batch cleared at {o.clearingPrice ? formatPrice(BigInt(o.clearingPrice), 4) : "—"}
                              </span>
                            ) : o.outcome === "not matched" ? (
                              <span className="tiny">no trade</span>
                            ) : (
                              <span className="tiny">resting</span>
                            )}
                          </td>
                          <td className="n">
                            {o.tx && (
                              <a href={`${EXPLORER}/tx/${o.tx}`} target="_blank" rel="noreferrer">
                                tx
                              </a>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="tiny">
                  Kept in this browser, because nobody else can keep it. The chain never held
                  your side, price or size, and the enclave discarded them when the batch
                  cleared — so this record exists here or nowhere.
                </p>
              </section>
            )}

            {/* Always present, because it is the argument. A trader should be able
                to see the exact boundary between what this venue publishes and
                what it destroys, without taking anyone's word for it. */}
            <section className="stack gap12">
              <span className="label">What this venue publishes about batch #{venue ? venue.batchId.toString() : "—"}</span>
              <div className="split">
                <div className="stack gap8">
                  <span className="tiny" style={{ color: "var(--amber)" }}>on-chain, readable by anyone</span>
                  <div className="ledger tight">
                    <div>
                      <span className="k">Orders resting</span>
                      <span className="lead" />
                      <span className="v">{venue ? venue.orderCount : "—"}</span>
                    </div>
                    <div>
                      <span className="k">Reference price</span>
                      <span className="lead" />
                      <span className="v">{oracle ? formatPrice(oracle, 4) : "—"}</span>
                    </div>
                    <div>
                      <span className="k">Fee if matched</span>
                      <span className="lead" />
                      <span className="v">{venue ? `${venue.feeBps} bps` : "—"}</span>
                    </div>
                  </div>
                </div>
                <div className="stack gap8">
                  <span className="tiny" style={{ color: "var(--jade)" }}>never leaves the enclave</span>
                  <div className="ledger tight">
                    <div>
                      <span className="k">Which side each order is</span>
                      <span className="lead" />
                      <span className="v sealed">sealed</span>
                    </div>
                    <div>
                      <span className="k">Limit price</span>
                      <span className="lead" />
                      <span className="v sealed">sealed</span>
                    </div>
                    <div>
                      <span className="k">Size</span>
                      <span className="lead" />
                      <span className="v sealed">sealed</span>
                    </div>
                  </div>
                </div>
              </div>
              <p className="tiny">
                Orders that do not trade are discarded inside the enclave when the batch clears.
                The chain never learns they existed beyond the count above — which is what lets
                you quote real size and keep it.
              </p>
            </section>

            {feed.length > 0 && (
              <section className="stack gap12">
                <span className="label">Activity</span>
                <ul className="feed">
                  {feed.map((e, i) => (
                    <li key={i} className={e.kind}>
                      <span className="t">{e.at}</span>
                      <span className="m">{e.msg}</span>
                      {e.tx && (
                        <a href={`${EXPLORER}/tx/${e.tx}`} target="_blank" rel="noreferrer">
                          tx
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          {/* ── ticket rail ───────────────────────────────────────────── */}
          <aside className="rail">
            <div className="ticket">
              <div className="seg">
                <button className={side === 0 ? "on" : ""} onClick={() => setSide(0)} disabled={stage !== "idle"}>
                  Buy
                </button>
                <button className={side === 1 ? "on" : ""} onClick={() => setSide(1)} disabled={stage !== "idle"}>
                  Sell
                </button>
              </div>

              <div className="field">
                <div className="cap">
                  <label className="label" htmlFor="limit">Limit</label>
                  <span className="tiny">
                    {QUOTE_SYMBOL} per {BASE_SYMBOL}
                  </span>
                </div>
                <input
                  id="limit" value={limit} inputMode="decimal" disabled={stage !== "idle"}
                  onChange={(e) => setLimit(e.target.value)}
                />
              </div>

              <div className="field">
                <div className="cap">
                  <label className="label" htmlFor="size">Size</label>
                  <span className="tiny">
                    {bal
                      ? side === 0
                        ? `${formatAmount(bal.venueQuote)} ${QUOTE_SYMBOL} free`
                        : `${formatAmount(bal.venueBase)} ${BASE_SYMBOL} free`
                      : ""}
                  </span>
                </div>
                <input
                  id="size" value={size} inputMode="decimal" disabled={stage !== "idle"}
                  onChange={(e) => setSize(e.target.value)}
                />
              </div>

              <div className="ledger tight">
                <div>
                  <span className="k">Notional</span>
                  <span className="lead" />
                  <span className="v">{notional !== null ? formatAmount(notional) : "—"}</span>
                </div>
                <div>
                  <span className="k">Fee if matched</span>
                  <span className="lead" />
                  <span className="v">{fee !== null ? formatAmount(fee, DECIMALS, 6) : "—"}</span>
                </div>
                <div>
                  <span className="k">If it never matches</span>
                  <span className="lead" />
                  <span className="v sealed">free</span>
                </div>
              </div>

              {!affordable && (
                <p className="tiny" style={{ color: "var(--amber)" }}>
                  Not enough {side === 0 ? QUOTE_SYMBOL : BASE_SYMBOL} in the venue. Add funds below.
                </p>
              )}
              {outOfBand && band && (
                <p className="tiny" style={{ color: "var(--amber)" }}>
                  Outside the oracle band ({formatPrice(band.lo, 4)}–{formatPrice(band.hi, 4)}). A
                  batch clearing there would be refused.
                </p>
              )}

              <button className="primary wide" disabled={!canPlace} onClick={() => run("placing order", placeOrder)}>
                {stage === "resting" ? "Order resting" : `Place sealed ${side === 0 ? "buy" : "sell"}`}
              </button>
              <p className="tiny" style={{ textAlign: "center" }}>
                One signature. Sealing happens in your browser.
              </p>
            </div>

            <div className="rail-block">
              <button className="disclose" onClick={() => setShowFunding((v) => !v)}>
                <span className="label">Balances &amp; funding</span>
                <span className="tiny mono">{showFunding ? "hide" : "show"}</span>
              </button>
              <div className="ledger tight">
                <div>
                  <span className="k">{BASE_SYMBOL}</span>
                  <span className="lead" />
                  <span className="v">{bal ? formatAmount(bal.venueBase) : "—"}</span>
                </div>
                <div>
                  <span className="k">{QUOTE_SYMBOL}</span>
                  <span className="lead" />
                  <span className="v">{bal ? formatAmount(bal.venueQuote) : "—"}</span>
                </div>
              </div>
              {showFunding && (
                <div className="stack gap12" style={{ marginTop: 12 }}>
                  <p className="tiny">
                    Funding is deliberately separate from ordering — if you funded the exact size
                    of a trade, the transfer would leak it.
                  </p>
                  <div className="row gap8">
                    <div className="field grow">
                      <label className="label" htmlFor="db">{BASE_SYMBOL}</label>
                      <input id="db" value={depBase} inputMode="decimal" onChange={(e) => setDepBase(e.target.value)} />
                    </div>
                    <div className="field grow">
                      <label className="label" htmlFor="dq">{QUOTE_SYMBOL}</label>
                      <input id="dq" value={depQuote} inputMode="decimal" onChange={(e) => setDepQuote(e.target.value)} />
                    </div>
                  </div>
                  <div className="row gap8">
                    <button className="grow" disabled={!!busy || !account} onClick={() => run("deposit", deposit)}>
                      Deposit
                    </button>
                    <button
                      className="grow"
                      disabled={!!busy || !account || stage === "resting"}
                      onClick={() => run("withdraw", withdraw)}
                    >
                      Withdraw
                    </button>
                  </div>
                  <button className="ghost" disabled={!!busy || !account} onClick={() => run("faucet", faucet)}>
                    Get test {QUOTE_SYMBOL}
                  </button>

                  <div className="xrpl">
                    <div className="between">
                      <span className="label">From the XRP Ledger</span>
                      <span className="tiny mono">no FLR needed</span>
                    </div>
                    <p className="tiny">
                      Pay XRP to the desk on the XRPL, putting the address you want credited in
                      the payment reference. Flare&rsquo;s Data Connector attests it and the
                      gateway credits you — we never hold the XRP.
                    </p>
                    <div className="ledger tight">
                      <div>
                        <span className="k">Pay to</span>
                        <span className="lead" />
                        <span className="v">
                          <a href={`${XRPL_EXPLORER}/accounts/${XRPL_DESK_ACCOUNT}`} target="_blank" rel="noreferrer">
                            {XRPL_DESK_ACCOUNT.slice(0, 10)}…{XRPL_DESK_ACCOUNT.slice(-4)}
                          </a>
                        </span>
                      </div>
                      <div>
                        <span className="k">Reference</span>
                        <span className="lead" />
                        <span className="v">
                          {account ? `${account.slice(0, 10)}…${account.slice(-4)}` : "connect a wallet"}
                        </span>
                      </div>
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="xrpltx">Your XRPL transaction hash</label>
                      <input
                        id="xrpltx"
                        value={xrplTx}
                        placeholder="0x…"
                        spellCheck={false}
                        onChange={(e) => setXrplTx(e.target.value)}
                      />
                    </div>
                    <button
                      className="grow"
                      disabled={xrplStage !== "idle" && xrplStage !== "done"}
                      onClick={claimFromXrpl}
                    >
                      {xrplStage === "idle" || xrplStage === "done" ? "Claim on Flare" : "Working…"}
                    </button>
                    {xrplNote && <p className="tiny">{xrplNote}</p>}
                    {xrplResult?.tx && (
                      <p className="tiny">
                        <span className="sealed">
                          {(Number(xrplResult.drops) / 1e6).toFixed(6)} XRP credited
                        </span>{" "}
                        <a href={`${EXPLORER}/tx/${xrplResult.tx}`} target="_blank" rel="noreferrer">
                          on Flare →
                        </a>
                      </p>
                    )}
                  </div>
                  {stage === "resting" && (
                    <p className="tiny">
                      Withdrawals are held while an order rests, so the funds behind it cannot be
                      pulled out from under it.
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="rail-block">
              <button className="disclose" onClick={() => setShowOperator((v) => !v)}>
                <span className="label">Operator</span>
                <span className="tiny mono">{showOperator ? "hide" : "show"}</span>
              </button>
              {showOperator && (
                <div className="stack gap12" style={{ marginTop: 12 }}>
                  <p className="tiny">
                    Clearing a batch is permissionless and costs gas, so in production a keeper
                    runs it on a schedule — no trader ever presses this. It is exposed here so you
                    can drive the whole loop yourself.
                  </p>
                  <button
                    className="wide"
                    disabled={!!busy || !account || !venue || venue.orderCount === 0 || stage === "matching"}
                    onClick={() => run("clearing batch", clearBatch)}
                  >
                    {venue && venue.orderCount === 0 ? "Nothing to clear" : "Clear batch now"}
                  </button>
                </div>
              )}
            </div>
          </aside>
        </div>
      </main>

      {busy && <div className="busy">{busy}…</div>}

      <style>{`
        .strip { border-bottom: 1px solid var(--hair); background: var(--panel); }
        .stat {
          display: flex; flex-direction: column; gap: 2px;
          padding: 11px 22px 11px 0; margin-right: 22px;
          border-right: 1px solid var(--hair);
        }
        .stat:last-child { border-right: 0; margin-right: 0; }
        .stat .k {
          font-family: var(--mono); font-size: 9.5px; text-transform: uppercase;
          letter-spacing: .16em; color: var(--dim);
        }
        .stat .v {
          font-family: var(--mono); font-size: 14px; font-variant-numeric: tabular-nums;
          letter-spacing: -.02em;
        }
        .deck {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 332px;
          gap: 48px;
          align-items: start;
        }
        .rail { display: flex; flex-direction: column; gap: 16px; position: sticky; top: 74px; }
        .ticket {
          border: 1px solid var(--line); border-radius: var(--r);
          background: linear-gradient(180deg, var(--panel-2), var(--panel));
          padding: 16px; display: flex; flex-direction: column; gap: 13px;
        }
        .rail-block { border-top: 1px solid var(--hair); padding-top: 14px; }
        .disclose {
          width: 100%; background: none; border: 0; padding: 0 0 10px;
          display: flex; align-items: center; justify-content: space-between;
        }
        .disclose:hover { background: none; }
        .ledger.tight > div { padding: 6px 0; }
        @media (max-width: 1000px) {
          /* minmax(0, …) rather than 1fr: a bare 1fr floors the column at its
             min-content width, so one wide table drags the whole page past the
             viewport and the document scrolls sideways. */
          .deck { grid-template-columns: minmax(0, 1fr); gap: 30px; }
          .rail { position: static; }
        }
      `}</style>
    </>
  );
}

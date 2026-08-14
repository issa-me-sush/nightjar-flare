"use client";

import { useEffect, useRef, useState } from "react";

const HEX = "0123456789abcdef";

/**
 * The order as anyone can read it on a transparent book.
 * These are the exact terms from the on-chain comparison.
 */
const TERMS: [string, string][] = [
  ["trader", "0xcb46cD10dE…"],
  ["side", "BUY"],
  ["limit", "1.06"],
  ["size", "3.000000 FXRP"],
];

/** A stand-in for the real 241-byte ciphertext, shaped the same way. */
function randomHex(n: number) {
  let s = "";
  for (let i = 0; i < n; i++) s += HEX[Math.floor(Math.random() * 16)];
  return s;
}

/**
 * Shows an order being sealed: readable terms dissolve into ciphertext, hold,
 * and resolve back. It is the product in one motion — the thing every other
 * venue publishes, and what this one publishes instead.
 */
export function SealDemo() {
  const [phase, setPhase] = useState<"exposed" | "sealing" | "sealed">("exposed");
  const [scramble, setScramble] = useState(0);
  const [cipher, setCipher] = useState(() => randomHex(320));
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  useEffect(() => {
    if (reduced.current) {
      setPhase("sealed");
      setScramble(1);
      return;
    }

    let raf = 0;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const loop = () => {
      if (cancelled) return;
      setPhase("exposed");
      setScramble(0);

      timers.push(
        setTimeout(() => {
          if (cancelled) return;
          setPhase("sealing");
          const start = performance.now();
          const DURATION = 900;

          const step = (t: number) => {
            if (cancelled) return;
            const p = Math.min(1, (t - start) / DURATION);
            setScramble(p);
            setCipher(randomHex(320));
            if (p < 1) raf = requestAnimationFrame(step);
            else {
              setPhase("sealed");
              timers.push(setTimeout(loop, 3400));
            }
          };
          raf = requestAnimationFrame(step);
        }, 1900)
      );
    };

    loop();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
    };
  }, []);

  /** Replaces a growing share of a string with hex, left to right. */
  const dissolve = (text: string, p: number) => {
    if (p <= 0) return text;
    if (p >= 1) return randomHex(text.length);
    const cut = Math.floor(text.length * p);
    return randomHex(cut) + text.slice(cut);
  };

  const sealed = phase === "sealed";

  return (
    <div className={`plate ${sealed ? "is-sealed" : "is-exposed"}`} style={{ gap: 14 }}>
      <div className="between">
        <span className="label">
          {sealed ? "what Nightjar puts on-chain" : "what a public book puts on-chain"}
        </span>
        <span className={sealed ? "pill sealed" : "pill exposed"}>
          <span className="dot" />
          {sealed ? "sealed" : "exposed"}
        </span>
      </div>

      {/* the readable order, dissolving */}
      <div className="readout" aria-hidden={sealed}>
        {TERMS.map(([k, v]) => (
          <div key={k}>
            <span className="k">{k.padEnd(7, " ")}</span>
            <span className={scramble > 0 ? "" : "v"} style={{ color: sealed ? "var(--jade)" : undefined }}>
              {dissolve(v, scramble)}
            </span>
          </div>
        ))}
      </div>

      <div className="rule" />

      <code
        style={{
          fontFamily: "var(--mono)",
          fontSize: 10.5,
          lineHeight: 1.7,
          color: sealed ? "var(--jade)" : "var(--faint)",
          opacity: sealed ? 0.85 : 0.35,
          wordBreak: "break-all",
          transition: "color .3s ease, opacity .3s ease",
        }}
      >
        {sealed || scramble > 0 ? `0x04${cipher}…` : "—"}
      </code>

      <p className="tiny" style={{ minHeight: "2.6em" }}>
        {sealed
          ? "241 bytes. No side, no price, no size — and if it never trades, these terms are destroyed inside the enclave and never published at all."
          : "Side, limit and size, readable by anyone who calls a view function. That is what the counterparty prices against."}
      </p>
    </div>
  );
}

/**
 * Your own order history, held in your own browser.
 *
 * This is not a shortcut around building an indexer. A venue whose whole point
 * is that it publishes nothing about your orders cannot then hand you a
 * history of them — the terms only ever existed in your browser and inside the
 * enclave, and after the batch clears they exist in neither. Per-trader deltas
 * survive in settlement calldata, but which order they came from does not.
 *
 * So the only party who can keep this record is you, and the honest place for
 * it is local storage. Clearing your browser really does destroy it, which is
 * the same property the venue is selling.
 */

const KEY = "nightjar.journal.v1";
const MAX = 50;

export type JournalEntry = {
  /** Wallet that placed it, so switching accounts does not mix histories. */
  account: string;
  batchId: number;
  side: 0 | 1;
  limit: string;
  size: string;
  /** Submission transaction — the only part of this the chain knows about. */
  tx?: string;
  at: number;
  /** Filled once the batch this order sat in has settled. */
  outcome?: "matched" | "not matched";
  clearingPrice?: string;
};

function read(): JournalEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as JournalEntry[]) : [];
  } catch {
    // A corrupt or unavailable store is not worth breaking the terminal over.
    return [];
  }
}

function write(entries: JournalEntry[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX)));
  } catch {
    /* private browsing, quota, disabled storage — all survivable */
  }
}

export function record(entry: JournalEntry): JournalEntry[] {
  const next = [entry, ...read()].slice(0, MAX);
  write(next);
  return next;
}

export function forAccount(account: string | null): JournalEntry[] {
  if (!account) return [];
  return read().filter((e) => e.account.toLowerCase() === account.toLowerCase());
}

/**
 * Settle the outcome of anything that was resting in a batch that has since
 * cleared. Matched volume of zero means the batch cleared without trading, so
 * nothing in it was filled; otherwise we can say the order's batch traded, but
 * deliberately not more than that — the venue does not tell us whose order
 * filled, and inventing that would be worse than leaving it.
 */
export function reconcile(
  settledBatches: { id: number; matchedBase: bigint; clearingPrice: bigint }[],
): JournalEntry[] {
  const byId = new Map(settledBatches.map((b) => [b.id, b]));
  const next = read().map((e) => {
    if (e.outcome) return e;
    const b = byId.get(e.batchId);
    if (!b) return e;
    return {
      ...e,
      outcome: (b.matchedBase > 0n ? "matched" : "not matched") as JournalEntry["outcome"],
      clearingPrice: b.clearingPrice.toString(),
    };
  });
  write(next);
  return next;
}

export function clear() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

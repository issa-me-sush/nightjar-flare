"use client";

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type Hash,
} from "viem";
import abi from "@/lib/nightjar-abi.json";
import { BASE_TOKEN, QUOTE_TOKEN, VENUE, coston2 } from "@/lib/config";

export const publicClient = createPublicClient({ chain: coston2, transport: http() });

export const erc20Abi = [
  { name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }] },
  { name: "allowance", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ type: "uint256" }] },
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "who", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "mint", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
] as const;

/** Flare Contract Registry — same address on every Flare network. */
const FLARE_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019" as const;

const registryAbi = [
  { name: "getContractAddressByName", type: "function", stateMutability: "view",
    inputs: [{ name: "name", type: "string" }], outputs: [{ type: "address" }] },
] as const;

const ftsoAbi = [
  { name: "getFeedById", type: "function", stateMutability: "payable",
    inputs: [{ name: "feedId", type: "bytes21" }],
    outputs: [{ type: "uint256" }, { type: "int8" }, { type: "uint64" }] },
] as const;

/** FTSO feed id for XRP/USD. */
const XRP_USD = "0x015852502f55534400000000000000000000000000" as const;

/**
 * Reads the same oracle the venue uses, scaled to 1e18.
 *
 * This is the reference a batch's clearing price has to sit near — inside the
 * enclave, and again on-chain at settlement — so it is worth showing traders
 * directly rather than leaving it implied.
 */
export async function readOraclePrice(): Promise<bigint | null> {
  try {
    const ftso = (await publicClient.readContract({
      address: FLARE_REGISTRY, abi: registryAbi,
      functionName: "getContractAddressByName", args: ["FtsoV2"],
    })) as Address;

    const [value, decimals] = (await publicClient.readContract({
      address: ftso, abi: ftsoAbi, functionName: "getFeedById", args: [XRP_USD],
    })) as [bigint, number, bigint];

    if (decimals < 0 || decimals > 18) return null;
    return value * 10n ** BigInt(18 - decimals);
  } catch {
    return null;
  }
}

/** FlareTeeManager diamond — emits TeeInstructionsSent when an instruction is dispatched. */
const TEE_MANAGER = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE".toLowerCase();

/** instructionId is the second indexed field of TeeInstructionsSent. */
export function instructionIdFrom(
  logs: readonly { address: string; topics: readonly string[] }[]
): Hash | null {
  for (const l of logs) {
    if (l.address.toLowerCase() === TEE_MANAGER && l.topics.length >= 3) {
      return l.topics[2] as Hash;
    }
  }
  return null;
}

export async function getWallet() {
  const eth = (window as unknown as { ethereum?: unknown }).ethereum;
  if (!eth) throw new Error("No wallet found. Install MetaMask to trade.");
  return createWalletClient({ chain: coston2, transport: custom(eth as never) });
}

export type VenueState = {
  batchId: bigint;
  orderCount: number;
  feeBps: number;
  maxFeeBps: number;
  maxDeviationBps: number;
  teeAddress: Address;
  feesCollected: bigint;
};

export async function readVenue(): Promise<VenueState> {
  const [batchId, feeBps, maxFeeBps, maxDeviationBps, teeAddress, feesCollected] =
    (await Promise.all([
      publicClient.readContract({ address: VENUE, abi, functionName: "currentBatchId" }),
      publicClient.readContract({ address: VENUE, abi, functionName: "feeBps" }),
      publicClient.readContract({ address: VENUE, abi, functionName: "MAX_FEE_BPS" }),
      publicClient.readContract({ address: VENUE, abi, functionName: "maxDeviationBps" }),
      publicClient.readContract({ address: VENUE, abi, functionName: "teeAddress" }),
      publicClient.readContract({ address: VENUE, abi, functionName: "feesCollected" }),
    ])) as [bigint, number, number, number, Address, bigint];

  const orderCount = (await publicClient.readContract({
    address: VENUE, abi, functionName: "batchOrderCount", args: [batchId],
  })) as number;

  return {
    batchId,
    orderCount: Number(orderCount),
    feeBps: Number(feeBps),
    maxFeeBps: Number(maxFeeBps),
    maxDeviationBps: Number(maxDeviationBps),
    teeAddress,
    feesCollected,
  };
}

export type Balances = {
  walletBase: bigint;
  walletQuote: bigint;
  venueBase: bigint;
  venueQuote: bigint;
  gas: bigint;
  lockedInBatch: bigint;
};

export async function readBalances(who: Address): Promise<Balances> {
  const [walletBase, walletQuote, venueBase, venueQuote, gas, lockedInBatch] =
    (await Promise.all([
      publicClient.readContract({ address: BASE_TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [who] }),
      publicClient.readContract({ address: QUOTE_TOKEN, abi: erc20Abi, functionName: "balanceOf", args: [who] }),
      publicClient.readContract({ address: VENUE, abi, functionName: "baseBalance", args: [who] }),
      publicClient.readContract({ address: VENUE, abi, functionName: "quoteBalance", args: [who] }),
      publicClient.getBalance({ address: who }),
      publicClient.readContract({ address: VENUE, abi, functionName: "lockedInBatch", args: [who] }),
    ])) as [bigint, bigint, bigint, bigint, bigint, bigint];

  return { walletBase, walletQuote, venueBase, venueQuote, gas, lockedInBatch };
}

export type BatchRecord = {
  id: number;
  clearingPrice: bigint;
  matchedBase: bigint;
  feeCharged: bigint;
  settledAt: number;
  fillCount: number;
  orderCount: number;
};

/**
 * Reads the venue's own settled history straight from storage.
 *
 * Deliberately not an event scan: the public Coston2 RPC caps `eth_getLogs` at
 * 30 blocks, which makes log history impractical for a browser client. The
 * contract records each settled batch, so history needs no indexer at all.
 */
export async function readHistory(currentBatch: bigint, limit = 8): Promise<BatchRecord[]> {
  const ids: number[] = [];
  for (let id = Number(currentBatch) - 1; id >= 1 && ids.length < limit; id--) ids.push(id);
  if (ids.length === 0) return [];

  const rows = await Promise.all(
    ids.map((id) =>
      publicClient.readContract({
        address: VENUE, abi, functionName: "batches", args: [BigInt(id)],
      }) as Promise<[bigint, bigint, bigint, bigint, number, number]>
    )
  );

  return rows.map((r, i) => ({
    id: ids[i],
    clearingPrice: r[0],
    matchedBase: r[1],
    feeCharged: r[2],
    settledAt: Number(r[3]),
    fillCount: Number(r[4]),
    orderCount: Number(r[5]),
  }));
}

export type Settlement = {
  batchId: number;
  clearingPrice: string;
  matchedBase: string;
  settlement: string;
  signature: string;
  unmatched: number;
  fills: { trader: string; baseDelta: string; quoteDelta: string }[];
};

/** Polls the enclave's result via the server route until it resolves. */
export async function pollSettlement(
  id: string,
  onTick: (seconds: number) => void,
  signal?: AbortSignal
): Promise<Settlement> {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (signal?.aborted) throw new Error("cancelled");
    onTick((i + 1) * 3);

    const res = await fetch(`/api/result/${id}`);
    const body = await res.json();
    if (body.status === "ok") return body.data as Settlement;
    if (body.status === "failed") {
      // A batch that does not cross, or one the oracle band rejects, is
      // abandoned — and its orders are destroyed rather than revealed.
      throw new Error(body.log || "the enclave abandoned this batch");
    }
  }
  throw new Error("timed out waiting for the enclave");
}

/** base64 (the wire encoding for bytes) → 0x-hex for viem. */
export function b64ToHex(v: string): `0x${string}` {
  if (v.startsWith("0x")) return v as `0x${string}`;
  const bin = atob(v);
  let out = "";
  for (let i = 0; i < bin.length; i++) out += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return `0x${out}`;
}

/** Turns a chain error into something a trader can act on. */
export function explain(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  if (/User rejected|denied transaction/i.test(msg)) return "You rejected the transaction.";
  if (/BalanceLocked/.test(msg)) return "Your balance is locked until the current batch settles.";
  if (/InsufficientBalance/.test(msg)) return "Not enough balance in the venue.";
  if (/TeeNotSet/.test(msg)) return "The venue has no enclave registered yet.";
  if (/NothingToDo/.test(msg)) return "There are no orders in this batch to clear.";
  if (/ClearingPriceOutOfBand/.test(msg)) return "The clearing price fell outside the oracle band, so the batch was refused.";
  if (/BatchAlreadySettled/.test(msg)) return "That batch has already settled.";
  if (/BadSignature/.test(msg)) return "The settlement signature did not match the registered enclave.";
  if (/insufficient funds/i.test(msg)) return "Not enough C2FLR for gas.";
  // Long RPC payloads are unreadable; keep the first line.
  return msg.split("\n")[0].slice(0, 180);
}

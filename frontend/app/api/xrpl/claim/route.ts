import { NextResponse } from "next/server";
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { coston2 } from "@/lib/config";

/**
 * Step one of arriving from the XRP Ledger: ask Flare's verifier to prepare an
 * attestation request for a payment, then submit it to FdcHub.
 *
 * This runs on the server for two reasons. The verifier wants an API key, which
 * should not be in a bundle; and the whole point of the rail is that someone
 * arriving from the XRPL has no FLR yet, so the request fee is paid for them.
 * That is not a trust concession — `fund()` is permissionless and the proof
 * names its own beneficiary, so a relayer can pay the gas and still cannot
 * redirect a single drop.
 */
export const dynamic = "force-dynamic";

const VERIFIER =
  "https://fdc-verifiers-testnet.flare.network/verifier/xrp/Payment/prepareRequest";
/** Flare's rate-limited public testnet key. A production deployment runs its own verifier. */
const VERIFIER_KEY = process.env.FDC_VERIFIER_API_KEY ?? "00000000-0000-0000-0000-000000000000";

const ATTESTATION_TYPE = "0x5061796d656e7400000000000000000000000000000000000000000000000000"; // "Payment"
const SOURCE_ID = "0x7465737458525000000000000000000000000000000000000000000000000000"; // "testXRP"
const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019" as const;

const registryAbi = parseAbi([
  "function getContractAddressByName(string) view returns (address)",
]);
const feeAbi = parseAbi(["function getRequestFee(bytes) view returns (uint256)"]);
const hubAbi = parseAbi(["function requestAttestation(bytes) payable"]);
const fsmAbi = parseAbi([
  "function firstVotingRoundStartTs() view returns (uint64)",
  "function votingEpochDurationSeconds() view returns (uint64)",
]);

export async function POST(request: Request) {
  const { txId } = await request.json().catch(() => ({ txId: "" }));
  if (typeof txId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txId)) {
    return NextResponse.json(
      { error: "Give me an XRP Ledger transaction hash — 0x followed by 64 hex characters." },
      { status: 400 },
    );
  }

  const relayerKey = process.env.RELAYER_PRIVATE_KEY;
  if (!relayerKey) {
    return NextResponse.json(
      { error: "This deployment has no relayer key set, so it cannot pay the attestation fee." },
      { status: 503 },
    );
  }

  // 1. Ask the verifier whether that payment exists and how to attest it.
  let prepared: { status?: string; abiEncodedRequest?: string };
  try {
    const res = await fetch(VERIFIER, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": VERIFIER_KEY },
      body: JSON.stringify({
        attestationType: ATTESTATION_TYPE,
        sourceId: SOURCE_ID,
        requestBody: { transactionId: txId.toLowerCase(), inUtxo: "0", utxo: "0" },
      }),
    });
    prepared = await res.json();
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach Flare's verifier: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  if (prepared.status !== "VALID" || !prepared.abiEncodedRequest) {
    return NextResponse.json(
      {
        error:
          `Flare's verifier will not attest that transaction (${prepared.status ?? "no status"}). ` +
          "It has to be a finalised payment on XRPL testnet.",
      },
      { status: 422 },
    );
  }
  const requestBytes = prepared.abiEncodedRequest as `0x${string}`;

  // 2. Submit it, paying the request fee on the payer's behalf.
  const account = privateKeyToAccount(
    (relayerKey.startsWith("0x") ? relayerKey : `0x${relayerKey}`) as `0x${string}`,
  );
  const pub = createPublicClient({ chain: coston2, transport: http() });
  const wallet = createWalletClient({ account, chain: coston2, transport: http() });

  try {
    const [hub, feeCfg, fsm] = await Promise.all(
      ["FdcHub", "FdcRequestFeeConfigurations", "FlareSystemsManager"].map((name) =>
        pub.readContract({
          address: REGISTRY,
          abi: registryAbi,
          functionName: "getContractAddressByName",
          args: [name],
        }),
      ),
    );

    const fee = await pub.readContract({
      address: feeCfg as `0x${string}`,
      abi: feeAbi,
      functionName: "getRequestFee",
      args: [requestBytes],
    });

    const hash = await wallet.writeContract({
      address: hub as `0x${string}`,
      abi: hubAbi,
      functionName: "requestAttestation",
      args: [requestBytes],
      value: fee,
      gas: 600_000n,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      return NextResponse.json({ error: "FdcHub rejected the attestation request." }, { status: 502 });
    }

    // 3. Work out which voting round it landed in, so the proof can be fetched.
    const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
    const [t0, dur] = await Promise.all([
      pub.readContract({ address: fsm as `0x${string}`, abi: fsmAbi, functionName: "firstVotingRoundStartTs" }),
      pub.readContract({ address: fsm as `0x${string}`, abi: fsmAbi, functionName: "votingEpochDurationSeconds" }),
    ]);
    const votingRound = (block.timestamp - BigInt(t0)) / BigInt(dur);

    return NextResponse.json({
      requestBytes,
      votingRound: votingRound.toString(),
      submittedTx: hash,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Submitting to FdcHub failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}

import { NextResponse } from "next/server";
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { coston2, XRPL_GATEWAY } from "@/lib/config";

/**
 * Step two: once the voting round finalises, pull the Merkle proof from the
 * Data Availability layer and present it to XrplGateway.
 *
 * A round takes a couple of minutes to finalise, so "not ready yet" is the
 * normal answer rather than an error — the client polls, and this reports
 * `pending` until the proof exists.
 */
export const dynamic = "force-dynamic";

const DA_LAYER = "https://ctn2-data-availability.flare.network/api/v1/fdc/proof-by-request-round-raw";

/** IPayment.Response, matching contracts/interfaces/IFdc.sol exactly. */
const RESPONSE = [
  {
    type: "tuple",
    components: [
      { name: "attestationType", type: "bytes32" },
      { name: "sourceId", type: "bytes32" },
      { name: "votingRound", type: "uint64" },
      { name: "lowestUsedTimestamp", type: "uint64" },
      {
        name: "requestBody",
        type: "tuple",
        components: [
          { name: "transactionId", type: "bytes32" },
          { name: "inUtxo", type: "uint256" },
          { name: "utxo", type: "uint256" },
        ],
      },
      {
        name: "responseBody",
        type: "tuple",
        components: [
          { name: "blockNumber", type: "uint64" },
          { name: "blockTimestamp", type: "uint64" },
          { name: "sourceAddressHash", type: "bytes32" },
          { name: "sourceAddressesRoot", type: "bytes32" },
          { name: "receivingAddressHash", type: "bytes32" },
          { name: "intendedReceivingAddressHash", type: "bytes32" },
          { name: "spentAmount", type: "int256" },
          { name: "intendedSpentAmount", type: "int256" },
          { name: "receivedAmount", type: "int256" },
          { name: "intendedReceivedAmount", type: "int256" },
          { name: "standardPaymentReference", type: "bytes32" },
          { name: "oneToOne", type: "bool" },
          { name: "status", type: "uint8" },
        ],
      },
    ],
  },
] as const;

const gatewayAbi = parseAbi([
  "struct RequestBody { bytes32 transactionId; uint256 inUtxo; uint256 utxo; }",
  "struct ResponseBody { uint64 blockNumber; uint64 blockTimestamp; bytes32 sourceAddressHash; bytes32 sourceAddressesRoot; bytes32 receivingAddressHash; bytes32 intendedReceivingAddressHash; int256 spentAmount; int256 intendedSpentAmount; int256 receivedAmount; int256 intendedReceivedAmount; bytes32 standardPaymentReference; bool oneToOne; uint8 status; }",
  "struct Response { bytes32 attestationType; bytes32 sourceId; uint64 votingRound; uint64 lowestUsedTimestamp; RequestBody requestBody; ResponseBody responseBody; }",
  "struct Proof { bytes32[] merkleProof; Response data; }",
  "function fund(Proof _proof) returns (uint256)",
  "function claimed(bytes32) view returns (bool)",
]);

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const { votingRound, requestBytes } = body as { votingRound?: string; requestBytes?: string };
  if (!votingRound || !requestBytes) {
    return NextResponse.json({ error: "Missing votingRound or requestBytes." }, { status: 400 });
  }

  // Pull the proof. Until the round finalises there is nothing to pull.
  let proofJson: { response_hex?: string; proof?: string[] };
  try {
    const res = await fetch(DA_LAYER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ votingRoundId: Number(votingRound), requestBytes }),
    });
    proofJson = await res.json();
  } catch (e) {
    return NextResponse.json({ error: `Data Availability layer: ${(e as Error).message}` }, { status: 502 });
  }
  if (!proofJson.response_hex) {
    return NextResponse.json({ pending: true });
  }

  const hex = (
    proofJson.response_hex.startsWith("0x") ? proofJson.response_hex : `0x${proofJson.response_hex}`
  ) as `0x${string}`;
  const [data] = decodeAbiParameters(RESPONSE, hex);
  const beneficiary = `0x${data.responseBody.standardPaymentReference.slice(26)}` as `0x${string}`;
  const drops = data.responseBody.receivedAmount;

  const pub = createPublicClient({ chain: coston2, transport: http() });

  // Someone else may have carried the same proof already; that is a success for
  // the payer, not an error, so say so rather than reverting in their face.
  const already = await pub.readContract({
    address: XRPL_GATEWAY,
    abi: gatewayAbi,
    functionName: "claimed",
    args: [data.requestBody.transactionId],
  });
  if (already) {
    return NextResponse.json({
      alreadyClaimed: true,
      beneficiary,
      drops: drops.toString(),
    });
  }

  const relayerKey = process.env.RELAYER_PRIVATE_KEY;
  if (!relayerKey) {
    return NextResponse.json({ error: "No relayer key configured." }, { status: 503 });
  }
  const account = privateKeyToAccount(
    (relayerKey.startsWith("0x") ? relayerKey : `0x${relayerKey}`) as `0x${string}`,
  );
  const wallet = createWalletClient({ account, chain: coston2, transport: http() });

  try {
    const hash = await wallet.writeContract({
      address: XRPL_GATEWAY,
      abi: gatewayAbi,
      functionName: "fund",
      args: [{ merkleProof: (proofJson.proof ?? []) as `0x${string}`[], data }],
      gas: 2_000_000n,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      return NextResponse.json(
        { error: "The gateway rejected the proof. Check the payment reached the desk's account." },
        { status: 422 },
      );
    }
    return NextResponse.json({ tx: hash, beneficiary, drops: drops.toString() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.split("\n")[0] }, { status: 502 });
  }
}

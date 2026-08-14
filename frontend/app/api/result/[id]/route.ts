import { NextResponse } from "next/server";

/**
 * Fetches an instruction result from the extension proxy.
 *
 * Proxied server-side for the same reasons as the TEE key route: the tunnel is
 * not reachable cross-origin from the browser, and the proxy URL stays out of
 * the client bundle.
 *
 * A settled batch returns the ABI-encoded settlement and the enclave's
 * signature over it. Those bytes are passed to `settle()` verbatim — the page
 * never rebuilds them, because re-encoding risks a byte-level mismatch with
 * what was signed.
 */
export const dynamic = "force-dynamic";

const PROXY_URL = process.env.EXT_PROXY_URL ?? "";

/**
 * The enclave's result arrives as 0x-hex of the JSON bytes.
 */
function decodePayload(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.startsWith("0x")) {
    return Buffer.from(raw.slice(2), "hex").toString("utf8");
  }
  // Some proxy versions base64 it instead; accept both.
  try {
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Go marshals big.Int as a bare JSON number, so a clearing price like
 * 1020000000000000000 arrives as an integer literal far beyond
 * Number.MAX_SAFE_INTEGER. Parsing it with JSON.parse would silently round it,
 * and the settlement would no longer match what the enclave signed.
 *
 * Quote any integer literal too long to survive a double, so it reaches the
 * client as a string and can be turned into a BigInt losslessly.
 */
function quoteBigIntegers(json: string): string {
  return json.replace(
    /:(\s*)(-?\d{16,})(\s*[,}\]])/g,
    (_m, pre: string, digits: string, post: string) => `:${pre}"${digits}"${post}`
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!PROXY_URL) {
    return NextResponse.json({ error: "EXT_PROXY_URL is not set." }, { status: 503 });
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) {
    return NextResponse.json({ error: "Malformed instruction id." }, { status: 400 });
  }

  try {
    const res = await fetch(`${PROXY_URL}/action/result/${id}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    // 404 means the result is not in storage yet — the caller should keep polling.
    if (res.status === 404) {
      return NextResponse.json({ status: "pending" });
    }
    if (!res.ok) {
      return NextResponse.json(
        { error: `Extension proxy returned ${res.status}` },
        { status: 502 }
      );
    }

    const body = await res.json();
    const result = body?.result ?? body?.Result;

    // Wire contract: status 0 = failed, 1 = success, 2 = still pending.
    if (!result || result.status === 2) {
      return NextResponse.json({ status: "pending" });
    }
    if (result.status === 0) {
      return NextResponse.json({ status: "failed", log: result.log ?? "" });
    }

    const text = decodePayload(result.data);
    if (text === null) {
      return NextResponse.json({ error: "Unreadable result payload." }, { status: 502 });
    }

    let data: unknown;
    try {
      data = JSON.parse(quoteBigIntegers(text));
    } catch {
      return NextResponse.json({ error: "Result payload was not valid JSON." }, { status: 502 });
    }

    return NextResponse.json({ status: "ok", data });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not reach the extension proxy: ${(err as Error).message}` },
      { status: 502 }
    );
  }
}

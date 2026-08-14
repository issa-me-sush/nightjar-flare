import { NextResponse } from "next/server";

/**
 * Serves the enclave's public key to the browser.
 *
 * The extension proxy is fetched server-side: the browser cannot reach a
 * cloudflared tunnel cross-origin, and EXT_PROXY_URL stays out of the client
 * bundle. Only the public key and a little status crosses to the page — never
 * anything an observer could use to open a sealed order.
 */
export const dynamic = "force-dynamic";

const PROXY_URL = process.env.EXT_PROXY_URL ?? "";

export async function GET() {
  if (!PROXY_URL) {
    return NextResponse.json(
      { error: "EXT_PROXY_URL is not set. Copy .env.local.example to .env.local." },
      { status: 503 }
    );
  }

  try {
    const res = await fetch(`${PROXY_URL}/info`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Extension proxy returned ${res.status}` },
        { status: 502 }
      );
    }

    const info = await res.json();
    const x: string | undefined = info?.teeInfo?.publicKey?.x;
    const y: string | undefined = info?.teeInfo?.publicKey?.y;

    if (!x || !y) {
      return NextResponse.json(
        { error: "Extension proxy did not report a TEE public key" },
        { status: 502 }
      );
    }

    // Uncompressed secp256k1 point, the form geth's ECIES expects.
    const publicKey = `0x04${x.slice(2)}${y.slice(2)}`;

    return NextResponse.json({
      publicKey,
      codeHash: info?.machineData?.codeHash ?? null,
      platform: info?.machineData?.platform ?? null,
      chainId: info?.teeInfo?.chainId ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not reach the extension proxy: ${(err as Error).message}` },
      { status: 502 }
    );
  }
}

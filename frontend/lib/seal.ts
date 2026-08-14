import { bytesToHex, eciesEncrypt, hexToBytes } from "./ecies";

/**
 * An order's terms, as they exist for the instant before they are sealed.
 * This object never leaves the browser in readable form.
 */
export type OrderTerms = {
  trader: string;
  /** 0 = buy base with quote, 1 = sell base for quote. */
  side: 0 | 1;
  /** Quote per base, scaled by 1e18, as a decimal string. */
  limitPrice: string;
  /** Base amount in token units, as a decimal string. */
  size: string;
  nonce: string;
};

/**
 * Seals an order to the TEE's public key.
 *
 * This is geth's ECIES: an ephemeral secp256k1 key, a Concat-KDF over the
 * shared secret, AES-128-CTR, and an HMAC-SHA256 tag — the exact scheme the
 * enclave's decrypt port expects. The layout is
 * `0x04 || R(64) || IV(16) || ciphertext || MAC(32)`.
 *
 * Only the enclave holds the matching private key, so from here until the
 * enclave opens it, nobody — including this page, the RPC node, and every
 * observer of the chain — can read the terms.
 */
export async function sealOrder(
  teePublicKey: `0x${string}`,
  terms: OrderTerms
): Promise<`0x${string}`> {
  const pub = hexToBytes(teePublicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("TEE public key must be 65 bytes, uncompressed (0x04 prefix)");
  }

  const plaintext = new TextEncoder().encode(JSON.stringify(terms));
  const sealed = await eciesEncrypt(pub, plaintext);
  return bytesToHex(sealed);
}

/** Formats a 1e18-scaled price for display. */
export function formatPrice(scaled: bigint, places = 4): string {
  const whole = scaled / 10n ** 18n;
  const frac = scaled % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, "0").slice(0, places);
  return `${whole}.${fracStr}`;
}

/** Parses a decimal price string into 1e18 fixed point. */
export function parsePrice(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Enter a price like 1.05");
  }
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (frac + "0".repeat(18)).slice(0, 18);
  return BigInt(whole) * 10n ** 18n + BigInt(padded || "0");
}

/** Parses a token amount string into 6-decimal base units. */
export function parseAmount(input: string, decimals = 6): bigint {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Enter an amount like 3.5");
  }
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/** Formats 6-decimal base units for display. */
export function formatAmount(value: bigint, decimals = 6, places = 4): string {
  const unit = 10n ** BigInt(decimals);
  const whole = value / unit;
  const frac = value % unit;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, places);
  return `${whole}.${fracStr}`;
}

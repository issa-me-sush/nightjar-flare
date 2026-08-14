import { getSharedSecret, getPublicKey, utils } from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";

/**
 * geth's ECIES, implemented against Web Crypto and audited pure-JS primitives.
 *
 * This must match `github.com/ethereum/go-ethereum/crypto/ecies` byte for byte,
 * because the enclave decrypts with it. For secp256k1 geth selects
 * ECIES_AES128_SHA256:
 *
 *   z   = X coordinate of (r · Pub), left-padded to 32 bytes
 *   K   = ConcatKDF(SHA-256, z, "", 32)      // NIST SP 800-56, counter from 1
 *   Ke  = K[0:16]                            // AES-128 key
 *   Km  = SHA-256(K[16:32])                  // MAC key, hashed again
 *   em  = IV(16) ‖ AES-128-CTR(Ke, IV, m)
 *   tag = HMAC-SHA-256(Km, em)
 *   out = 0x04 ‖ Rx(32) ‖ Ry(32) ‖ em ‖ tag
 *
 * The library alternative (`ecies-geth`) pulls in Node built-ins and native
 * secp256k1 bindings, which do not survive a modern browser bundler. This is
 * ~50 lines and is round-trip tested against the Go implementation.
 */

const AES_KEY_LEN = 16;
const IV_LEN = 16;

/** NIST SP 800-56 Concatenation KDF with SHA-256. */
function concatKDF(z: Uint8Array, keyLen: number): Uint8Array {
  const out = new Uint8Array(keyLen);
  let written = 0;
  let counter = 1;

  while (written < keyLen) {
    const input = new Uint8Array(4 + z.length);
    // Counter is big-endian uint32.
    input[0] = (counter >>> 24) & 0xff;
    input[1] = (counter >>> 16) & 0xff;
    input[2] = (counter >>> 8) & 0xff;
    input[3] = counter & 0xff;
    input.set(z, 4);

    const digest = sha256(input);
    const take = Math.min(digest.length, keyLen - written);
    out.set(digest.subarray(0, take), written);
    written += take;
    counter += 1;
  }

  return out;
}

async function aesCtr(
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "AES-CTR" },
    false,
    ["encrypt"]
  );
  const result = await crypto.subtle.encrypt(
    // geth's symEncrypt uses the whole 16-byte IV as the initial counter block.
    { name: "AES-CTR", counter: iv as BufferSource, length: 128 },
    cryptoKey,
    data as BufferSource
  );
  return new Uint8Array(result);
}

/**
 * Encrypts `message` to an uncompressed secp256k1 public key (65 bytes, 0x04).
 */
export async function eciesEncrypt(
  publicKey: Uint8Array,
  message: Uint8Array
): Promise<Uint8Array> {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("public key must be 65 bytes, uncompressed");
  }

  const ephemeralPriv = utils.randomSecretKey();
  const ephemeralPub = getPublicKey(ephemeralPriv, false); // 65 bytes

  // getSharedSecret returns the full point; geth uses only the X coordinate.
  const shared = getSharedSecret(ephemeralPriv, publicKey, false);
  const z = shared.slice(1, 33);

  const derived = concatKDF(z, AES_KEY_LEN * 2);
  const ke = derived.slice(0, AES_KEY_LEN);
  const km = sha256(derived.slice(AES_KEY_LEN));

  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ciphertext = await aesCtr(ke, iv, message);

  // em = IV ‖ ciphertext, and the tag covers all of it.
  const em = new Uint8Array(iv.length + ciphertext.length);
  em.set(iv, 0);
  em.set(ciphertext, iv.length);

  const tag = hmac(sha256, km, em);

  const out = new Uint8Array(ephemeralPub.length + em.length + tag.length);
  out.set(ephemeralPub, 0);
  out.set(em, ephemeralPub.length);
  out.set(tag, ephemeralPub.length + em.length);
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return `0x${s}`;
}

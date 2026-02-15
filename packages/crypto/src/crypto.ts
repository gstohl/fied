/**
 * AES-256-GCM encryption/decryption.
 *
 * Works in both Node.js (via globalThis.crypto / webcrypto) and browsers.
 * The key is 32 bytes (256 bits), encoded as base64url for URL fragments.
 */

const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12;

/**
 * Get the Web Crypto API — works in Node 18+ and all modern browsers.
 */
function getSubtleCrypto(): SubtleCrypto {
  if (typeof globalThis.crypto?.subtle !== "undefined") {
    return globalThis.crypto.subtle;
  }
  throw new Error("Web Crypto API not available");
}

function getRandomValues(buf: Uint8Array): Uint8Array {
  if (typeof globalThis.crypto?.getRandomValues !== "undefined") {
    return globalThis.crypto.getRandomValues(buf);
  }
  throw new Error("crypto.getRandomValues not available");
}

/**
 * Generate a random 256-bit AES key and return it as raw bytes.
 */
export async function generateKey(): Promise<Uint8Array> {
  const key = await getSubtleCrypto().generateKey(
    { name: ALGORITHM, length: KEY_LENGTH },
    true,
    ["encrypt", "decrypt"]
  );
  const raw = await getSubtleCrypto().exportKey("raw", key);
  return new Uint8Array(raw);
}

/**
 * Import raw key bytes into a CryptoKey for encrypt/decrypt.
 */
export async function importKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return getSubtleCrypto().importKey(
    "raw",
    rawKey.buffer as ArrayBuffer,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Generate a random 12-byte IV.
 */
export function generateIV(): Uint8Array {
  return getRandomValues(new Uint8Array(IV_LENGTH));
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns { iv, ciphertext } where ciphertext includes the 16-byte auth tag.
 */
export async function encrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  additionalData?: Uint8Array,
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = generateIV();
  const algorithm: AesGcmParams = { name: ALGORITHM, iv: iv as BufferSource };
  if (additionalData) {
    algorithm.additionalData = additionalData as BufferSource;
  }
  const encrypted = await getSubtleCrypto().encrypt(
    algorithm,
    key,
    plaintext as BufferSource
  );
  return { iv, ciphertext: new Uint8Array(encrypted) };
}

/**
 * Decrypt ciphertext with AES-256-GCM.
 * The ciphertext must include the 16-byte auth tag (as produced by WebCrypto).
 */
export async function decrypt(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  const algorithm: AesGcmParams = { name: ALGORITHM, iv: iv as BufferSource };
  if (additionalData) {
    algorithm.additionalData = additionalData as BufferSource;
  }
  const decrypted = await getSubtleCrypto().decrypt(
    algorithm,
    key,
    ciphertext as BufferSource
  );
  return new Uint8Array(decrypted);
}

/**
 * Encode bytes to base64url (no padding).
 */
export function toBase64Url(bytes: Uint8Array): string {
  let base64: string;
  if (typeof btoa === "function") {
    base64 = btoa(String.fromCharCode(...bytes));
  } else {
    base64 = Buffer.from(bytes).toString("base64");
  }
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode base64url string to bytes.
 */
export function fromBase64Url(str: string): Uint8Array {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }

  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } else {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
}

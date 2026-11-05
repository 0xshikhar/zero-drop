/**
 * Adapter for core exports that the package index does not re-export yet.
 * `abi.ts` is not exported from packages/core/src/index.ts, and the package `exports` map only allows ".",
 * so the ABI is imported by relative path here. Nothing in packages/core was changed.
 */
export { zeroDropAbi, semaphoreVerifierAdapterAbi } from "../../../../packages/core/src/abi";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Accepts either a 0x-prefixed 32-byte digest or a CIDv1 string (raw codec, sha2-256, base32 lowercase, "b...").
 * Returns the digest hex, or undefined with a reason. CIDv0 ("Qm...") is not supported.
 */
export function parseCidDigest(input: string): { digest?: `0x${string}`; reason?: string } {
  const text = input.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(text)) return { digest: text.toLowerCase() as `0x${string}` };
  if (text.startsWith("Qm")) return { reason: "CIDv0 is not supported. Use a CIDv1 (base32, starts with b)." };
  if (!text.startsWith("b")) return { reason: "Expected a CIDv1 string (starts with b) or a 0x-prefixed 32-byte digest." };
  const bytes = base32Decode(text.slice(1));
  if (!bytes) return { reason: "The CID contains characters outside base32." };
  // version 0x01, codec varint (raw = 0x55), multihash sha2-256 (0x12) with length 0x20, then 32 digest bytes
  if (bytes.length !== 36 || bytes[0] !== 0x01 || bytes[1] !== 0x55 || bytes[2] !== 0x12 || bytes[3] !== 0x20) {
    return { reason: "Only CIDv1 raw sha2-256 CIDs are supported." };
  }
  const hex = Array.from(bytes.slice(4), (b) => b.toString(16).padStart(2, "0")).join("");
  return { digest: `0x${hex}` };
}

function base32Decode(text: string): Uint8Array | undefined {
  const out: number[] = [];
  let value = 0;
  let bits = 0;
  for (const ch of text) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) return undefined;
    value = ((value << 5) | idx) & 0x1fff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

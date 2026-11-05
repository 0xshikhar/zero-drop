import type { Hex } from "viem";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** CIDv1 (raw, sha2-256, base32 lowercase) for a 32-byte digest. Inverse of parseCidDigest. */
export function cidFromDigest(digest: Hex): string {
  const hex = digest.slice(2);
  const bytes = [0x01, 0x55, 0x12, 0x20];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  let bits = 0;
  let value = 0;
  let out = "b";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export type Sniffed =
  | { kind: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp" }
  | { kind: "text"; text: string }
  | { kind: "binary" };

/** What a verified document is, from its bytes alone (nothing on chain records the media type). */
export function sniff(bytes: Uint8Array): Sniffed {
  const startsWith = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return { kind: "image", mediaType: "image/png" };
  if (startsWith(0xff, 0xd8, 0xff)) return { kind: "image", mediaType: "image/jpeg" };
  if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { kind: "image", mediaType: "image/webp" };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.includes("\u0000")) return { kind: "text", text };
  } catch {
    // not UTF-8
  }
  return { kind: "binary" };
}

export function mediaTypeOf(bytes: Uint8Array): "text/plain" | "image/jpeg" | "image/png" | "image/webp" {
  const s = sniff(bytes);
  return s.kind === "image" ? s.mediaType : "text/plain";
}

/** Triggers a browser download of `data`. */
export function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function short(hex: string, head = 10, tail = 6): string {
  return hex.length > head + tail + 1 ? `${hex.slice(0, head)}…${hex.slice(-tail)}` : hex;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: string }).shortMessage;
    return short ?? error.message.split("\n")[0] ?? error.message;
  }
  return String(error);
}

export function shareLink(ref: string): string {
  return `${window.location.origin}${window.location.pathname}#/d/${ref}`;
}

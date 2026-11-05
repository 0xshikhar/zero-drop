import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { sha256 as viemSha256 } from "viem";

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";
export type TextMediaType = "text/plain" | "text/markdown";

/** Metadata markers found by scanning the raw bytes of an image. */
export type MetadataFindings = {
  /** An EXIF block (JPEG APP1 "Exif", PNG eXIf chunk, WebP EXIF chunk) is present. */
  exif: boolean;
  /** An XMP packet ("http://ns.adobe.com/xap") is present. */
  xmp: boolean;
  /**
   * GPS coordinates live inside the EXIF block, and proving their absence needs a full EXIF parse,
   * so this is true whenever EXIF is present. It is a "cannot rule out", not a confirmed location.
   */
  gpsPossible: boolean;
};

export type PreparedDocument = {
  /** The bytes that will be hashed, stored and disclosed. */
  bytes: Uint8Array;
  mediaType: ImageMediaType | TextMediaType;
  /** Human-readable notes for the diff UI. Always describes what was actually done. */
  warnings: string[];
  /** Set for images only. `found` is what the input contained; `residual` is what the output still contains. */
  metadata?: {
    found: MetadataFindings;
    removed: Array<"exif" | "xmp">;
    residual: MetadataFindings;
  };
};

/** Thrown for file types or environments that cannot be prepared safely. */
export class UnsupportedMediaError extends Error {
  override name = "UnsupportedMediaError";
}

const TEXT_TYPES = new Set<string>(["text/plain", "text/markdown", "text/x-markdown"]);
const IMAGE_TYPES = new Set<string>(["image/jpeg", "image/png", "image/webp"]);
const TEXT_EXT = /\.(md|markdown|txt)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const PDF_EXT = /\.pdf$/i;
const RAW_CODEC = 0x55;
const SHA2_256_CODE = 0x12;
const ENCODE_QUALITY = 0.92;

/**
 * Prepares a file for hashing and disclosure.
 * - text/plain and text/markdown: CRLF to LF and Unicode NFC normalization.
 * - image/jpeg, image/png, image/webp: decoded and re-encoded through a canvas in the browser, which
 *   drops EXIF, XMP and other ancillary metadata. Lossy formats are re-encoded at quality 0.92.
 * - PDF and everything else: rejected with UnsupportedMediaError. PDF metadata stripping is not implemented.
 */
export async function prepareDocument(file: File): Promise<PreparedDocument> {
  const declared = (file.type || "").toLowerCase();

  if (declared === "application/pdf" || PDF_EXT.test(file.name)) {
    throw new UnsupportedMediaError(
      "PDF metadata stripping is not implemented yet, so PDF files cannot be prepared.",
    );
  }

  const isTextByName = TEXT_EXT.test(file.name);
  if (TEXT_TYPES.has(declared) || (!declared && isTextByName) || (declared === "application/octet-stream" && isTextByName)) {
    return prepareText(file, declared === "text/markdown" || /\.(md|markdown)$/i.test(file.name) ? "text/markdown" : "text/plain");
  }

  if (IMAGE_TYPES.has(declared) || (!declared && IMAGE_EXT.test(file.name))) {
    return prepareImage(file);
  }

  throw new UnsupportedMediaError(
    `Unsupported file type "${declared || file.name}". Supported: text/plain, text/markdown, image/jpeg, image/png, image/webp.`,
  );
}

async function prepareText(file: File, mediaType: TextMediaType): Promise<PreparedDocument> {
  const original = await file.text();
  const lfOnly = original.replace(/\r\n?/g, "\n");
  const normalized = lfOnly.normalize("NFC");

  const warnings: string[] = [];
  if (lfOnly !== original) warnings.push("Line endings were converted from CRLF/CR to LF.");
  if (normalized !== lfOnly) warnings.push("Text was normalized to Unicode NFC.");
  warnings.push(
    "The digest covers the normalized bytes, so it differs from a digest of the original file.",
    "The text is not scanned. Names, emails or other identifying details written in the content are kept.",
  );

  return { bytes: new TextEncoder().encode(normalized), mediaType, warnings };
}

async function prepareImage(file: File): Promise<PreparedDocument> {
  if (!canReencodeImages()) {
    throw new UnsupportedMediaError("Image re-encoding needs a browser canvas. It is not available in this environment.");
  }

  const input = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffImageType(input);
  if (!sniffed) {
    throw new UnsupportedMediaError("The file contents are not a JPEG, PNG or WebP image.");
  }
  const declared = (file.type || "").toLowerCase();
  if (declared && declared !== sniffed) {
    throw new UnsupportedMediaError(`The file is declared as ${declared} but its contents are ${sniffed}.`);
  }

  const found = scanMetadata(input);
  const output = await reencodeImage(input, sniffed);
  const residual = scanMetadata(output);

  const removed: Array<"exif" | "xmp"> = [];
  if (found.exif) removed.push("exif");
  if (found.xmp) removed.push("xmp");

  const warnings = [
    "Images are re-encoded in your browser. Pixels are kept, but the output bytes differ from the original file.",
    "Pixel content is not checked. Faces, screen contents, and other visual identifiers remain.",
  ];
  if (sniffed !== "image/png") warnings.push("JPEG and WebP are re-encoded lossy at quality 0.92.");
  if (found.exif) warnings.push("Camera and EXIF metadata, including any GPS data, was present and is removed by re-encoding.");
  if (found.xmp) warnings.push("XMP metadata was present and is removed by re-encoding.");
  if (!found.exif && !found.xmp) warnings.push("No EXIF or XMP metadata markers were found in the input.");
  if (residual.exif || residual.xmp) {
    warnings.push("Metadata markers are still present after re-encoding. Do not disclose this file.");
  }

  return {
    bytes: output,
    mediaType: sniffed,
    warnings,
    metadata: { found, removed, residual },
  };
}

function canReencodeImages(): boolean {
  return (
    typeof createImageBitmap === "function" &&
    (typeof OffscreenCanvas !== "undefined" || typeof document !== "undefined")
  );
}

async function reencodeImage(input: Uint8Array, mediaType: ImageMediaType): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([input], { type: mediaType }), { imageOrientation: "from-image" });
  try {
    const { width, height } = bitmap;
    let blob: Blob | null;
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new UnsupportedMediaError("Canvas 2D context is not available.");
      ctx.drawImage(bitmap, 0, 0);
      blob = await canvas.convertToBlob({ type: mediaType, quality: ENCODE_QUALITY });
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new UnsupportedMediaError("Canvas 2D context is not available.");
      ctx.drawImage(bitmap, 0, 0);
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mediaType, ENCODE_QUALITY));
    }
    // Browsers that cannot encode a format silently fall back to PNG, so check the result type.
    if (!blob || blob.type !== mediaType) {
      throw new UnsupportedMediaError(`This browser cannot re-encode ${mediaType}.`);
    }
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

function sniffImageType(bytes: Uint8Array): ImageMediaType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && indexOfBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0, 8) === 0) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    indexOfBytes(bytes, ascii("RIFF"), 0, 4) === 0 &&
    indexOfBytes(bytes, ascii("WEBP"), 8, 12) === 8
  ) {
    return "image/webp";
  }
  return undefined;
}

/**
 * Scans the raw bytes for metadata markers. This is a marker scan, not a parser: it can over-report
 * (a random byte run can look like a marker) but it should not miss a block that is stored uncompressed.
 */
export function scanMetadata(bytes: Uint8Array): MetadataFindings {
  const exif =
    indexOfBytes(bytes, ascii("Exif\0\0")) !== -1 || // JPEG APP1
    indexOfBytes(bytes, ascii("eXIf")) !== -1 || // PNG chunk
    indexOfBytes(bytes, ascii("EXIF")) !== -1; // WebP chunk
  const xmp = indexOfBytes(bytes, ascii("http://ns.adobe.com/xap")) !== -1;
  return { exif, xmp, gpsPossible: exif };
}

function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0) & 0xff);
}

function indexOfBytes(haystack: Uint8Array, needle: number[], start = 0, end = haystack.length): number {
  const last = Math.min(end, haystack.length) - needle.length;
  outer: for (let i = start; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** SHA-256 of the bytes as a 0x-prefixed hex string. Async, WebCrypto based. */
export async function sha256(bytes: Uint8Array): Promise<`0x${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `0x${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The 32-byte SHA-256 digest of the bytes, as 0x-prefixed hex. This is the cidDigest the contract stores. Synchronous. */
export function digestOf(bytes: Uint8Array): `0x${string}` {
  return viemSha256(bytes, "hex");
}

/** CIDv1 (raw codec, sha2-256, base32) for the bytes. Synchronous. */
export function cidFor(bytes: Uint8Array): string {
  const digest = Digest.create(SHA2_256_CODE, hexToBytes(digestOf(bytes)));
  return CID.create(1, RAW_CODEC, digest).toString();
}

/** True when the bytes hash to expectedDigest (0x-prefixed 32-byte hex, case-insensitive). */
export function checkContentHash(bytes: Uint8Array, expectedDigest: string): boolean {
  if (!/^0x[0-9a-fA-F]{64}$/.test(expectedDigest)) return false;
  return digestOf(bytes).toLowerCase() === expectedDigest.toLowerCase();
}

function hexToBytes(hex: `0x${string}`): Uint8Array {
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

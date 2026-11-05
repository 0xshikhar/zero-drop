import { describe, expect, it } from "vitest";
import { cidFor, checkContentHash, digestOf, prepareDocument, scanMetadata, sha256, UnsupportedMediaError } from "../src/content";
import { PDFDocument, PDFName } from "pdf-lib";
import { inspectPdfMetadata } from "../src/pdf";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import { sha256 as mfSha256 } from "multiformats/hashes/sha2";

const enc = new TextEncoder();
const EMPTY_SHA256 = "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("content", () => {
  it("digestOf matches the known SHA-256 of the empty input and of 'abc'", async () => {
    expect(digestOf(new Uint8Array())).toBe(EMPTY_SHA256);
    expect(digestOf(enc.encode("abc"))).toBe("0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256(enc.encode("abc"))).toBe(digestOf(enc.encode("abc")));
  });

  it("cidFor is CIDv1 raw/sha2-256 and matches multiformats' async path", async () => {
    // Known CIDv1 (raw, sha2-256) of the empty block.
    expect(cidFor(new Uint8Array())).toBe("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
    const bytes = enc.encode("zerodrop");
    const reference = CID.create(1, 0x55, await mfSha256.digest(bytes)).toString();
    expect(cidFor(bytes)).toBe(reference);
    const parsed = CID.parse(cidFor(bytes));
    expect(parsed.code).toBe(0x55);
    expect(parsed.multihash.code).toBe(0x12);
    expect(Digest.equals(parsed.multihash, await mfSha256.digest(bytes))).toBe(true);
  });

  it("checkContentHash accepts the right digest only", () => {
    const bytes = enc.encode("hello");
    expect(checkContentHash(bytes, digestOf(bytes))).toBe(true);
    expect(checkContentHash(bytes, digestOf(bytes).toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(checkContentHash(enc.encode("hellO"), digestOf(bytes))).toBe(false);
    expect(checkContentHash(bytes, "0x1234")).toBe(false);
  });

  it("text is normalized to LF and NFC with honest warnings", async () => {
    const file = new File(["a\r\nb\rc é"], "note.md", { type: "text/markdown" });
    const out = await prepareDocument(file);
    expect(out.mediaType).toBe("text/markdown");
    expect(new TextDecoder().decode(out.bytes)).toBe("a\nb\nc é");
    expect(out.warnings.join(" ")).toMatch(/LF/);
    expect(out.warnings.join(" ")).toMatch(/NFC/);
    expect(out.metadata).toBeUndefined();
  });

  it("unknown types are rejected", async () => {
    await expect(prepareDocument(new File(["x"], "a.bin", { type: "application/x-foo" }))).rejects.toThrow(
      /Unsupported file type/,
    );
  });

  it("PDFs are stripped through prepareDocument with the metadata shape and removed/residual lists", async () => {
    const doc = await PDFDocument.create();
    doc.setAuthor("Jane Whistleblower");
    doc.setProducer("Acme PDF Writer");
    doc.setTitle("Memo");
    doc.addPage().drawText("body text", { x: 10, y: 10 });
    const xmp = doc.context.stream("<x:xmpmeta>Jane</x:xmpmeta>", { Type: "Metadata", Subtype: "XML" });
    doc.catalog.set(PDFName.of("Metadata"), doc.context.register(xmp));
    const bytes = await doc.save();

    for (const file of [
      new File([bytes as BlobPart], "memo.pdf", { type: "application/pdf" }),
      new File([bytes as BlobPart], "memo.pdf", { type: "" }),
    ]) {
      const out = await prepareDocument(file);
      expect(out.mediaType).toBe("application/pdf");
      expect(out.metadata?.found.xmp).toBe(true);
      expect(out.metadata?.removed).toEqual(["xmp"]);
      expect(out.metadata?.residual).toEqual({ exif: false, xmp: false, gpsPossible: false });
      expect(out.pdf?.removed.join("|")).toMatch(/Info\.Author \(Jane Whistleblower\)/);
      expect(out.pdf?.residual.join(" ")).toMatch(/Page text/);
      expect(out.warnings.join(" ")).toMatch(/printer tracking dots/);
      expect(Buffer.from(out.bytes).toString("latin1")).not.toContain("Jane");
      expect((await inspectPdfMetadata(out.bytes)).fields).toEqual([]);
    }
  });

  it("encrypted, corrupt and mislabelled PDFs are rejected with UnsupportedMediaError", async () => {
    await expect(prepareDocument(new File(["%PDF-1.4 garbage"], "a.pdf", { type: "application/pdf" }))).rejects.toBeInstanceOf(
      UnsupportedMediaError,
    );
    await expect(prepareDocument(new File(["not a pdf at all"], "a.pdf", { type: "application/pdf" }))).rejects.toThrow(/PDF header/);
    const doc = await PDFDocument.create();
    doc.addPage();
    const text = Buffer.from(await doc.save({ useObjectStreams: false })).toString("latin1").replace(
      /trailer\s*<</,
      "trailer\n<< /Encrypt << /Filter /Standard /V 1 /R 2 /O (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) /U (bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) /P -4 >>",
    );
    await expect(prepareDocument(new File([Buffer.from(text, "latin1")], "enc.pdf", { type: "application/pdf" }))).rejects.toThrow(/encrypted/);
  });

  it("images are refused with a clear error when no canvas exists (node)", async () => {
    await expect(prepareDocument(new File([new Uint8Array([0xff, 0xd8, 0xff])], "a.jpg", { type: "image/jpeg" }))).rejects.toThrow(
      /canvas/,
    );
  });

  it("scanMetadata finds EXIF, XMP and nothing in clean bytes", () => {
    const exif = new Uint8Array([0xff, 0xd8, 0xff, ...enc.encode("Exif\0\0"), 1, 2, 3]);
    expect(scanMetadata(exif)).toEqual({ exif: true, xmp: false, gpsPossible: true });
    const xmp = enc.encode("...http://ns.adobe.com/xap/1.0/...");
    expect(scanMetadata(xmp)).toEqual({ exif: false, xmp: true, gpsPossible: false });
    expect(scanMetadata(enc.encode("plain"))).toEqual({ exif: false, xmp: false, gpsPossible: false });
  });
});

import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString, StandardFonts } from "pdf-lib";
import { inspectPdfMetadata, PdfError, stripPdf, PDF_PIN_LIMIT_BYTES } from "../src/pdf";

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

/** A PDF with Info metadata, a hand-made XMP stream, PieceInfo, an attachment, a JS OpenAction and a text annotation. */
async function dirtyPdf(opts: { jpegExif?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Secret Memo");
  doc.setAuthor("Jane Whistleblower");
  doc.setSubject("Internal");
  doc.setKeywords(["acme", "leak"]);
  doc.setCreator("Microsoft Word");
  doc.setProducer("Acme PDF Writer 9");
  doc.setCreationDate(new Date("2024-01-02T03:04:05Z"));
  doc.setModificationDate(new Date("2024-02-03T04:05:06Z"));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 200]);
  page.drawText("hello world", { x: 20, y: 100, size: 14, font });
  const ctx = doc.context;

  const xmp = ctx.stream(
    '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:creator>Jane Whistleblower</dc:creator></x:xmpmeta><?xpacket end="w"?>',
    { Type: "Metadata", Subtype: "XML" },
  );
  doc.catalog.set(PDFName.of("Metadata"), ctx.register(xmp));
  const pageXmp = ctx.stream("<x:xmpmeta>page author Jane</x:xmpmeta>", { Type: "Metadata", Subtype: "XML" });
  page.node.set(PDFName.of("Metadata"), ctx.register(pageXmp));
  doc.catalog.set(PDFName.of("PieceInfo"), ctx.obj({ AcmeApp: { LastModified: PDFString.of("D:20240102"), Private: "internal-path-C:/Users/jane" } }));
  page.node.set(PDFName.of("PieceInfo"), ctx.obj({ AcmeApp: { Private: "page-private-jane" } }));

  await doc.attach(new TextEncoder().encode("attached secret text"), "notes.txt", { mimeType: "text/plain", description: "private notes" });

  doc.catalog.set(PDFName.of("OpenAction"), ctx.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of("app.alert('hi')") }));
  await doc.attach(new TextEncoder().encode("second attachment"), "more.txt", { mimeType: "text/plain" });
  // attach() is deferred until save, so save and reload to get a real Names tree to extend.
  const reloaded = await PDFDocument.load(await doc.save({ useObjectStreams: false }), { updateMetadata: false });
  return finishFixture(reloaded, opts);
}

async function finishFixture(doc: PDFDocument, opts: { jpegExif?: boolean }): Promise<Uint8Array> {
  const ctx = doc.context;
  const page = doc.getPage(0);
  doc.context.trailerInfo.ID = ctx.obj([PDFHexString.of("0123456789abcdef0123456789abcdef"), PDFHexString.of("0123456789abcdef0123456789abcdef")]);
  const namesDict = doc.catalog.lookup(PDFName.of("Names"), PDFDict);
  namesDict.set(PDFName.of("JavaScript"), ctx.obj({ Names: [PDFString.of("init"), ctx.obj({ S: "JavaScript", JS: PDFString.of("app.alert(1)") })] }));

  page.node.set(PDFName.of("Annots"), ctx.obj([ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [10, 10, 30, 30], Contents: PDFString.of("a comment"), T: PDFString.of("Jane Whistleblower"), M: PDFString.of("D:20240102") }))]));

  if (opts.jpegExif) {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xd9]);
    const img = ctx.stream(jpeg, { Type: "XObject", Subtype: "Image", Width: 1, Height: 1, ColorSpace: "DeviceGray", BitsPerComponent: 8, Filter: "DCTDecode" });
    page.node.newXObject("Im1", ctx.register(img));
  }
  return doc.save({ useObjectStreams: false });
}

describe("pdf stripping", () => {
  it("fixture really contains the metadata (inspection sees it)", async () => {
    const before = await inspectPdfMetadata(await dirtyPdf());
    expect(before.info.Author).toBe("Jane Whistleblower");
    expect(before.info.Producer).toBeTruthy();
    for (const f of ["Info.Author", "Info.Title", "Info.Subject", "Info.Keywords", "Info.Creator", "Info.Producer", "Info.CreationDate", "Info.ModDate", "XMP", "PieceInfo", "EmbeddedFiles", "JavaScript", "AnnotationAuthor", "DocumentID"]) {
      expect(before.fields, f).toContain(f);
    }
    expect(before.counts.XMP).toBe(2);
    expect(before.counts.PieceInfo).toBe(2);
  });

  it("strips everything covered, verified by re-parsing the output", async () => {
    const input = await dirtyPdf();
    const result = await stripPdf(input);
    const again = await inspectPdfMetadata(result.bytes);
    expect(again.fields).toEqual([]);
    expect(again.info).toEqual({});
    expect(result.after.fields).toEqual([]);

    const raw = latin1(result.bytes);
    for (const needle of ["Jane", "Whistleblower", "Acme PDF Writer", "Microsoft Word", "notes.txt", "attached secret", "second attachment", "app.alert", "internal-path", "xmpmeta", "/Producer", "/Author", "/ID"]) {
      expect(raw, needle).not.toContain(needle);
    }
    // pdf-lib must not have stamped its own identity.
    expect(raw).not.toContain("pdf-lib");
    expect(raw).not.toContain("/Producer");
    expect(raw).not.toContain("/Creator");

    expect(result.removed.some((r) => r.startsWith("Info.Author (Jane Whistleblower"))).toBe(true);
    expect(result.removed.join("|")).toMatch(/XMP metadata stream x2/);
    expect(result.removed.join("|")).toMatch(/Embedded file/);
    expect(result.removed.join("|")).toMatch(/JavaScript/);
    expect(result.residual.join(" ")).toMatch(/Page text/);
    expect(result.residual.join(" ")).toMatch(/font names/);
    expect(result.warnings.join(" ")).toMatch(/printer tracking dots/);
    expect(result.warnings.join(" ")).toMatch(/not rasterised/);
  });

  it("keeps the page: still loads, same page count and identical content stream", async () => {
    const input = await dirtyPdf();
    const result = await stripPdf(input);
    const doc = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(1);
    const original = await PDFDocument.load(input, { updateMetadata: false });
    const contentsOf = (d: PDFDocument) => {
      const contents = d.context.lookup(d.getPage(0).node.get(PDFName.of("Contents")));
      const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i, PDFRawStream)) : [contents as PDFRawStream];
      return Buffer.concat(streams.map((s) => Buffer.from(s.getContents())));
    };
    // The page content stream (text, graphics) is byte-identical: stripping does not touch content.
    expect(contentsOf(doc).equals(contentsOf(original))).toBe(true);
    // Annotation text is content and stays, author/date go.
    const raw = latin1(result.bytes);
    expect(raw).toContain("a comment");
    expect(result.residual.join(" ")).toMatch(/Annotations/);
  });

  it("is deterministic and idempotent", async () => {
    const input = await dirtyPdf();
    const a = await stripPdf(input);
    const b = await stripPdf(input);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    const twice = await stripPdf(a.bytes);
    expect(Buffer.from(twice.bytes).equals(Buffer.from(a.bytes))).toBe(true);
    expect(twice.removed).toEqual([]);
    expect(twice.warnings.join(" ")).toMatch(/No covered metadata/);
  });

  it("reports EXIF inside embedded JPEGs as residual, not removed", async () => {
    const result = await stripPdf(await dirtyPdf({ jpegExif: true }));
    expect(result.after.jpegWithMetadata).toBe(1);
    expect(result.residual.join(" ")).toMatch(/embedded JPEG/);
    expect(result.warnings.join(" ")).toMatch(/Embedded JPEG images keep their own EXIF/);
  });

  it("warns when the stripped output exceeds the 1 MiB pin limit", async () => {
    const doc = await PDFDocument.create();
    doc.setAuthor("x");
    const page = doc.addPage();
    const noise = new Uint8Array(1_300_000);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    page.node.set(PDFName.of("Big"), doc.context.register(doc.context.stream(noise)));
    const result = await stripPdf(await doc.save());
    expect(result.bytes.length).toBeGreaterThan(PDF_PIN_LIMIT_BYTES);
    expect(result.warnings.join(" ")).toMatch(/over the 1 MiB/);
  });

  it("drops orphaned objects left by an incremental update (old Info stays unreachable)", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.context.register(doc.context.obj({ Author: PDFString.of("Orphan Author") })); // unreferenced
    const result = await stripPdf(await doc.save({ useObjectStreams: false }));
    expect(latin1(result.bytes)).not.toContain("Orphan Author");
  });

  it("rejects encrypted, corrupt and non-PDF input with a clear PdfError", async () => {
    const encrypted = await dirtyPdf();
    // Splice a trailer /Encrypt entry in so the parser treats it as encrypted.
    const text = latin1(encrypted).replace("trailer\n<<", "trailer\n<<\n/Encrypt << /Filter /Standard /V 1 /R 2 /O (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) /U (bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) /P -4 >>");
    await expect(stripPdf(Uint8Array.from(Buffer.from(text, "latin1")))).rejects.toMatchObject({ name: "PdfError", code: "encrypted" });

    await expect(stripPdf(new TextEncoder().encode("hello, not a pdf"))).rejects.toMatchObject({ code: "not-pdf" });
    await expect(stripPdf(new Uint8Array())).rejects.toBeInstanceOf(PdfError);

    const truncated = (await dirtyPdf()).slice(0, 120);
    await expect(stripPdf(truncated)).rejects.toMatchObject({ name: "PdfError", code: "corrupt" });
    await expect(inspectPdfMetadata(new TextEncoder().encode("%PDF-1.4\ngarbage garbage"))).rejects.toBeInstanceOf(PdfError);
  });
});

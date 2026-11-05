import {
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from "pdf-lib";

/**
 * PDF metadata stripping without rasterising. The file is parsed with pdf-lib, the metadata-bearing
 * objects are removed from the object graph, unreachable objects are dropped, and the file is
 * re-serialised. Page content (text, vector graphics, images, fonts) is NOT modified.
 */

/** Same cap the pinner enforces (see MAX_DOCUMENT_BYTES in pin.ts; duplicated to avoid an import cycle). */
export const PDF_PIN_LIMIT_BYTES = 1_048_576;
/** Inputs above this are refused so a huge file cannot stall the browser. */
export const PDF_MAX_INPUT_BYTES = 32 * 1024 * 1024;

export type PdfErrorCode = "not-pdf" | "encrypted" | "corrupt" | "too-large";

/** Thrown for input that cannot be stripped. Never thrown for a successfully stripped file. */
export class PdfError extends Error {
  override name = "PdfError";
  constructor(
    readonly code: PdfErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type PdfInspection = {
  /**
   * Stable labels for every metadata-bearing field found, for example "Info.Author", "XMP",
   * "PieceInfo", "DocumentID", "EmbeddedFiles", "JavaScript", "AdditionalActions", "AnnotationAuthor".
   * Sorted. Empty means none of the covered fields are present.
   */
  fields: string[];
  /** Info dictionary entries (key to decoded value). Empty when there is no Info dictionary. */
  info: Record<string, string>;
  /** How many objects carry each label (an XMP stream per page counts once each). */
  counts: Record<string, number>;
  /** Embedded JPEG images whose bytes contain EXIF or XMP markers. These are reported, never removed. */
  jpegWithMetadata: number;
  /** Distinct /BaseFont names of fonts referenced by the file. */
  fontNames: string[];
  imageCount: number;
  pageCount: number;
  hasForm: boolean;
  hasAnnotations: boolean;
  hasOutline: boolean;
};

export type PdfStripResult = {
  bytes: Uint8Array;
  /** What the input contained and the output no longer does, as human-readable lines. */
  removed: string[];
  /** What the output still contains (content that is not metadata, or metadata that survived). */
  residual: string[];
  warnings: string[];
  /** Inspection of the input and of the re-parsed output, for the diff UI. */
  before: PdfInspection;
  after: PdfInspection;
};

const N = (name: string) => PDFName.of(name);

/** Returns the bytes after checking they look like a PDF. */
function assertPdfBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new PdfError("not-pdf", "The file is empty.");
  if (bytes.length > PDF_MAX_INPUT_BYTES) {
    throw new PdfError("too-large", `The PDF is ${bytes.length} bytes; the limit for stripping is ${PDF_MAX_INPUT_BYTES}.`);
  }
  // The header may be preceded by a few junk bytes; the spec allows it within the first 1024.
  const head = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 1024)));
  if (!head.includes("%PDF-")) throw new PdfError("not-pdf", "The file does not start with a PDF header (%PDF-).");
}

async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  assertPdfBytes(bytes);
  try {
    // updateMetadata:false stops pdf-lib from stamping its own Producer/Creator/ModDate on load.
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: false });
    if (!safeLookupDict(doc.context.trailerInfo.Root, doc.context) || doc.getPageCount() === 0) {
      throw new Error("no document catalog or pages found");
    }
    return doc;
  } catch (error) {
    // Match by name/message too: the class can come from a different pdf-lib module copy (ESM vs CJS).
    if (error instanceof EncryptedPDFError || (error instanceof Error && (error.name === "EncryptedPDFError" || /is encrypted/.test(error.message)))) {
      throw new PdfError("encrypted", "The PDF is encrypted. Remove the password protection first; encrypted PDFs cannot be stripped.");
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new PdfError("corrupt", `The PDF could not be parsed (${detail}). It may be corrupt or truncated.`);
  }
}

/**
 * Reads a PDF and reports which metadata-bearing fields it contains. Read-only. Used by the tests
 * and by the UI diff to verify an output by re-parsing it.
 */
export async function inspectPdfMetadata(bytes: Uint8Array): Promise<PdfInspection> {
  const doc = await loadPdf(bytes);
  return analyze(doc, false);
}

/**
 * Removes document metadata from a PDF, deterministically, without rasterising.
 *
 * Removed when present: the whole Info dictionary (Title, Author, Subject, Keywords, Creator, Producer,
 * CreationDate, ModDate and any custom keys), XMP /Metadata streams (catalog, pages and any other
 * object), /PieceInfo (catalog and pages), the trailer /ID, embedded file attachments (Names
 * /EmbeddedFiles, catalog /AF, FileAttachment annotations), JavaScript (Names /JavaScript, JavaScript
 * actions in /OpenAction and /A), additional-action (/AA) triggers, and author/date fields on
 * non-form annotations. Objects left unreachable are dropped. No Producer or Creator is added.
 *
 * Throws PdfError for non-PDF, encrypted, corrupt or oversized input.
 */
export async function stripPdf(bytes: Uint8Array): Promise<PdfStripResult> {
  const doc = await loadPdf(bytes);
  const before = analyze(doc, false);
  analyze(doc, true);
  pruneUnreachable(doc);

  let out: Uint8Array;
  try {
    out = await doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PdfError("corrupt", `The cleaned PDF could not be written (${detail}).`);
  }

  // Verify by re-parsing the actual output, not by trusting the edit.
  const after = await inspectPdfMetadata(out);

  const removed = describeRemoved(before, after);
  const residual: string[] = [];
  const warnings: string[] = [];

  if (after.fields.length > 0) {
    residual.push(`Metadata still present after stripping: ${after.fields.join(", ")}`);
    warnings.push("Metadata fields are still present after stripping. Do not disclose this file.");
  }
  residual.push("Page text and vector graphics, unchanged. Names, emails and other identifying content in the visible document are kept.");
  if (after.imageCount > 0) residual.push(`${after.imageCount} embedded image(s), unchanged. Pixel content is not checked.`);
  if (after.fontNames.length > 0) {
    residual.push(`Embedded font names, which can hint at the software that made the file: ${after.fontNames.slice(0, 10).join(", ")}${after.fontNames.length > 10 ? ", ..." : ""}`);
  }
  if (after.jpegWithMetadata > 0) {
    residual.push(`${after.jpegWithMetadata} embedded JPEG image(s) still carry EXIF/XMP markers inside the image data (may include GPS).`);
    warnings.push("Embedded JPEG images keep their own EXIF/XMP. This tool does not edit image data inside a PDF. Re-encode those images before building the PDF.");
  }
  if (after.hasForm) residual.push("Form fields and their entered values.");
  if (after.hasAnnotations) residual.push("Annotations and comment text (author and date fields were removed, the text was not).");
  if (after.hasOutline) residual.push("Bookmarks / outline titles.");

  warnings.push(
    "The PDF is cleaned structurally, not rasterised. The page content is byte-for-byte what the original contained.",
    "If the PDF is a scan or a print-to-PDF of a printed page, printer tracking dots (yellow dots) in the image remain.",
    "Generator fingerprints can remain: PDF structure and object order, font subset names, and content stream style.",
    "The output bytes differ from the original file, so its digest differs from a digest of the original.",
  );
  if (out.length > PDF_PIN_LIMIT_BYTES) {
    warnings.push(
      `The stripped PDF is ${out.length} bytes, over the 1 MiB (${PDF_PIN_LIMIT_BYTES}) limit. Pinners will reject it. Reduce its size before publishing.`,
    );
  }
  if (removed.length === 0) warnings.push("No covered metadata fields were found in the input.");

  return { bytes: out, removed, residual, warnings, before, after };
}

function describeRemoved(before: PdfInspection, after: PdfInspection): string[] {
  const out: string[] = [];
  for (const field of before.fields) {
    if (after.fields.includes(field)) continue;
    if (field.startsWith("Info.")) {
      const key = field.slice(5);
      const value = before.info[key];
      out.push(`Info.${key}${value !== undefined && value !== "" ? ` (${truncate(value)})` : ""}`);
      continue;
    }
    const count = before.counts[field] ?? 1;
    out.push(LABELS[field] ? `${LABELS[field]}${count > 1 ? ` x${count}` : ""}` : field);
  }
  return out;
}

const LABELS: Record<string, string> = {
  XMP: "XMP metadata stream",
  PieceInfo: "PieceInfo (application private data)",
  DocumentID: "Document ID (trailer /ID)",
  EmbeddedFiles: "Embedded file attachment",
  JavaScript: "JavaScript action",
  AdditionalActions: "Additional-action (/AA) triggers",
  AnnotationAuthor: "Annotation author/date fields",
};

function truncate(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}

// ---------------------------------------------------------------------------------------------
// Object-graph analysis and cleaning. One walker serves both inspection (mutate=false) and
// cleaning (mutate=true), so what is reported is exactly what is removed.
// ---------------------------------------------------------------------------------------------

function analyze(doc: PDFDocument, mutate: boolean): PdfInspection {
  const context = doc.context;
  const counts: Record<string, number> = {};
  const bump = (label: string, by = 1) => {
    counts[label] = (counts[label] ?? 0) + by;
  };
  const info: Record<string, string> = {};
  const fontNames = new Set<string>();
  let jpegWithMetadata = 0;
  let imageCount = 0;
  let pageCount = 0;
  let hasForm = false;
  let hasAnnotations = false;
  let hasOutline = false;

  // Trailer: Info dictionary and document ID.
  const infoDict = safeLookupDict(context.trailerInfo.Info, context);
  if (infoDict) {
    for (const [key, value] of infoDict.entries()) {
      const name = key.decodeText();
      info[name] = decodeValue(context.lookup(value));
      bump(`Info.${name}`);
    }
  }
  if (context.trailerInfo.ID) bump("DocumentID");
  if (mutate) {
    context.trailerInfo.Info = undefined;
    context.trailerInfo.ID = undefined;
  }

  // Catalog.
  const catalog = safeLookupDict(context.trailerInfo.Root, context);
  if (catalog) {
    hasForm = catalog.has(N("AcroForm")) && hasFormFields(catalog, context);
    hasOutline = catalog.has(N("Outlines"));
    cleanCatalog(catalog, context, bump, mutate);
  }

  // Every indirect object: generic keys, fonts, images.
  for (const [, obj] of context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : undefined;
    if (!dict) continue;

    if (dict.has(N("Metadata"))) {
      bump("XMP");
      if (mutate) dict.delete(N("Metadata"));
    }
    if (dict.has(N("PieceInfo"))) {
      bump("PieceInfo");
      if (mutate) dict.delete(N("PieceInfo"));
    }
    if (dict.has(N("AA"))) {
      bump("AdditionalActions");
      if (mutate) dict.delete(N("AA"));
    }
    for (const key of ["A", "OpenAction"]) {
      const action = safeLookupDict(dict.get(N(key)), context);
      if (action && isJavaScriptAction(action)) {
        bump("JavaScript");
        if (mutate) dict.delete(N(key));
      }
    }

    const subtype = nameOf(dict.lookup(N("Subtype")));
    if (subtype === "Image") {
      imageCount++;
      if (obj instanceof PDFRawStream && hasFilter(dict, "DCTDecode") && jpegHasMetadata(obj.getContents())) jpegWithMetadata++;
    }
    if (nameOf(dict.lookup(N("Type"))) === "Font") {
      const base = nameOf(dict.lookup(N("BaseFont")));
      if (base) fontNames.add(base);
    }
  }

  // Pages: annotations.
  let pages: ReturnType<PDFDocument["getPages"]> = [];
  try {
    pages = doc.getPages();
  } catch {
    // A broken page tree does not stop metadata removal; page-level checks are skipped.
  }
  pageCount = pages.length;
  for (const page of pages) {
    const annots = page.node.lookupMaybe(N("Annots"), PDFArray);
    if (!annots) continue;
    const keep: PDFObject[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const annot = safeLookupDict(raw, context);
      if (!annot) {
        keep.push(raw);
        continue;
      }
      const sub = nameOf(annot.lookup(N("Subtype")));
      if (sub === "FileAttachment") {
        bump("EmbeddedFiles");
        if (!mutate) keep.push(raw);
        continue;
      }
      if (sub !== "Widget" && sub !== "Link") hasAnnotations = true;
      if (sub !== "Widget") {
        let authored = false;
        for (const key of ["T", "M", "CreationDate", "Subj"]) {
          if (annot.has(N(key))) {
            authored = true;
            if (mutate) annot.delete(N(key));
          }
        }
        if (authored) bump("AnnotationAuthor");
      }
      keep.push(raw);
    }
    if (mutate && keep.length !== annots.size()) {
      page.node.set(N("Annots"), context.obj(keep));
    }
  }

  const fields = Object.keys(counts).sort();
  return {
    fields,
    info,
    counts,
    jpegWithMetadata,
    fontNames: [...fontNames].sort(),
    imageCount,
    pageCount,
    hasForm,
    hasAnnotations,
    hasOutline,
  };
}

function cleanCatalog(
  catalog: PDFDict,
  context: PDFDocument["context"],
  bump: (label: string, by?: number) => void,
  mutate: boolean,
): void {
  const names = safeLookupDict(catalog.get(N("Names")), context);
  if (names) {
    const embedded = names.has(N("EmbeddedFiles"));
    if (embedded) {
      bump("EmbeddedFiles");
      if (mutate) names.delete(N("EmbeddedFiles"));
    }
    if (names.has(N("JavaScript"))) {
      bump("JavaScript");
      if (mutate) names.delete(N("JavaScript"));
    }
  }
  if (catalog.has(N("AF"))) {
    bump("EmbeddedFiles");
    if (mutate) catalog.delete(N("AF"));
  }
  // The generic pass handles /OpenAction, /AA, /Metadata and /PieceInfo on the catalog (it is an indirect object).
}

function hasFormFields(catalog: PDFDict, context: PDFDocument["context"]): boolean {
  const form = safeLookupDict(catalog.get(N("AcroForm")), context);
  const fields = form?.lookupMaybe(N("Fields"), PDFArray);
  return !!fields && fields.size() > 0;
}

/** Deletes every indirect object that cannot be reached from the catalog, so old revisions and orphans do not survive. */
function pruneUnreachable(doc: PDFDocument): void {
  const context = doc.context;
  const seen = new Set<string>();
  const queue: PDFObject[] = [];
  const push = (value: PDFObject | undefined) => {
    if (value !== undefined) queue.push(value);
  };
  push(context.trailerInfo.Root);
  push(context.trailerInfo.Encrypt);
  push(context.trailerInfo.Info);

  while (queue.length > 0) {
    const value = queue.pop() as PDFObject;
    if (value instanceof PDFRef) {
      const key = value.tag;
      if (seen.has(key)) continue;
      seen.add(key);
      push(context.lookup(value));
    } else if (value instanceof PDFDict) {
      for (const child of value.values()) push(child);
    } else if (value instanceof PDFStream) {
      for (const child of value.dict.values()) push(child);
    } else if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i++) push(value.get(i));
    }
  }

  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) context.delete(ref);
  }
}

// --- small helpers ---------------------------------------------------------------------------

function safeLookupDict(value: PDFObject | undefined, context: PDFDocument["context"]): PDFDict | undefined {
  if (!value) return undefined;
  try {
    const resolved = context.lookup(value);
    if (resolved instanceof PDFDict) return resolved;
    if (resolved instanceof PDFStream) return resolved.dict;
  } catch {
    // dangling reference
  }
  return undefined;
}

function nameOf(value: PDFObject | undefined): string | undefined {
  return value instanceof PDFName ? value.decodeText() : undefined;
}

function isJavaScriptAction(action: PDFDict): boolean {
  if (nameOf(action.lookup(N("S"))) === "JavaScript") return true;
  return action.has(N("JS"));
}

function hasFilter(dict: PDFDict, filter: string): boolean {
  const value = dict.lookup(N("Filter"));
  if (value instanceof PDFName) return value.decodeText() === filter;
  if (value instanceof PDFArray) {
    for (let i = 0; i < value.size(); i++) {
      const item = value.lookup(i);
      if (item instanceof PDFName && item.decodeText() === filter) return true;
    }
  }
  return false;
}

const EXIF_MARK = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const XMP_MARK = Array.from("http://ns.adobe.com/xap", (c) => c.charCodeAt(0));

function jpegHasMetadata(data: Uint8Array): boolean {
  return indexOfBytes(data, EXIF_MARK) !== -1 || indexOfBytes(data, XMP_MARK) !== -1;
}

function indexOfBytes(haystack: Uint8Array, needle: number[]): number {
  const last = haystack.length - needle.length;
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function decodeValue(value: PDFObject | undefined): string {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  if (value instanceof PDFName) return value.decodeText();
  if (value instanceof PDFNumber) return String(value.asNumber());
  return value ? value.toString() : "";
}

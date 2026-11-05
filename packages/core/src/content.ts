export type PreparedDocument = {
  bytes: Uint8Array;
  mediaType: string;
  warnings: string[];
};

/**
 * Conservative first pass: normalizes text only. Binary metadata removal is not
 * implemented yet and must not be implied by the UI.
 */
export async function prepareDocument(file: File): Promise<PreparedDocument> {
  const warnings = [
    "Binary metadata stripping is not implemented. This file is kept unchanged.",
    "Content, printer dots, and details that identify the author are not removed.",
  ];

  if (file.type.startsWith("text/") || /\.(md|markdown|txt)$/i.test(file.name)) {
    const text = (await file.text()).replace(/\r\n?/g, "\n").normalize("NFC");
    return {
      bytes: new TextEncoder().encode(text),
      mediaType: file.type || "text/plain",
      warnings: [warnings[1]],
    };
  }

  return { bytes: new Uint8Array(await file.arrayBuffer()), mediaType: file.type || "application/octet-stream", warnings };
}

export async function sha256(bytes: Uint8Array): Promise<`0x${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `0x${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

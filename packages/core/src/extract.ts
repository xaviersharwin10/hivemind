/**
 * Text extraction from artifact bytes.
 *
 * Used in two places:
 *  - ingest: pull a content excerpt so a file's *contents* (not just its name)
 *    become semantically searchable in MemWal.
 *  - hivemind-read MCP: turn the decrypted bytes into readable text so an AI can
 *    actually read a PDF/text file, instead of receiving raw bytes.
 *
 * PDF → text via pdf-parse (pdf.js). Plain text → decoded. Anything else (images,
 * unknown binaries) → reported as binary with no text.
 */

export type ExtractKind = "pdf" | "text" | "binary";

export interface Extracted {
  kind: ExtractKind;
  /** Extracted text (empty for binary or failed extraction). */
  text: string;
}

function isPdf(bytes: Uint8Array): boolean {
  // "%PDF"
  return bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

/** Heuristic: does this look like decodable text rather than a binary blob? */
function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  if (n === 0) return false;
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return false; // NUL byte → binary
    // control chars excluding tab(9), LF(10), CR(13)
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return control / n < 0.05;
}

/** Collapse whitespace and trim to a clean single-line-ish excerpt of at most `max` chars. */
export function excerptOf(text: string, max = 800): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

/** Extract readable text from a file's bytes. Never throws. */
export async function extractText(bytes: Uint8Array, mimeHint?: string): Promise<Extracted> {
  if (isPdf(bytes) || mimeHint === "application/pdf") {
    try {
      const { PDFParse } = await import("pdf-parse");
      // Copy: pdf.js may detach/transfer the underlying buffer.
      const parser = new PDFParse({ data: new Uint8Array(bytes) });
      const res = await parser.getText();
      await parser.destroy();
      return { kind: "pdf", text: (res.text ?? "").trim() };
    } catch {
      return { kind: "pdf", text: "" };
    }
  }
  if (looksLikeText(bytes)) {
    return { kind: "text", text: new TextDecoder().decode(bytes) };
  }
  return { kind: "binary", text: "" };
}

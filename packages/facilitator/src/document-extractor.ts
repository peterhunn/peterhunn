/**
 * Document text extraction for template registration.
 *
 * Supported formats:
 *   - PDF  (application/pdf)
 *   - DOCX (application/vnd.openxmlformats-officedocument.wordprocessingml.document)
 *   - Plain text (text/plain, text/markdown)
 *
 * The extracted text is used as template content and can then be registered
 * with the facilitator's template store for x490 contract negotiation.
 */

export interface DocumentExtractResult {
  text: string;
  /** Detected format. */
  format: "pdf" | "docx" | "text";
  /** Number of pages (PDF only). */
  pages?: number;
  /** Warnings from the parser (non-fatal issues). */
  warnings: string[];
}

/** MIME types supported by extractDocumentText. */
export const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
] as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export function isSupportedMimeType(mime: string): mime is SupportedMimeType {
  return (SUPPORTED_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * Extract plain text from a document buffer.
 *
 * @param buffer  Raw file bytes.
 * @param mimeType  MIME type of the document (used to select parser).
 */
export async function extractDocumentText(
  buffer: ArrayBuffer | Uint8Array,
  mimeType: string,
): Promise<DocumentExtractResult> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (mimeType === "application/pdf") {
    return extractPdf(bytes);
  }

  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return extractDocx(bytes);
  }

  if (mimeType === "text/plain" || mimeType === "text/markdown") {
    return { text: new TextDecoder().decode(bytes), format: "text", warnings: [] };
  }

  throw new Error(`Unsupported document type: ${mimeType}. Supported: ${SUPPORTED_MIME_TYPES.join(", ")}`);
}

async function extractPdf(bytes: Uint8Array): Promise<DocumentExtractResult> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const warnings: string[] = [];

  const task = pdfjs.getDocument({ data: bytes });
  const doc = await task.promise;
  const pageTexts: string[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const parts: string[] = [];
    for (const item of content.items) {
      if ("str" in item) {
        // TextItem has str and hasEOL; TextMarkedContent does not
        const textItem = item as { str: string; hasEOL: boolean };
        parts.push(textItem.hasEOL ? textItem.str + "\n" : textItem.str);
      }
    }
    const pageText = parts.join(" ").replace(/  +/g, " ").trim();
    if (pageText) pageTexts.push(pageText);
  }

  return {
    text: pageTexts.join("\n\n"),
    format: "pdf",
    pages: doc.numPages,
    warnings,
  };
}

async function extractDocx(bytes: Uint8Array): Promise<DocumentExtractResult> {
  const mammoth = await import("mammoth");
  const warnings: string[] = [];

  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });

  for (const msg of result.messages) {
    if (msg.type === "warning" || msg.type === "error") {
      warnings.push(msg.message);
    }
  }

  return {
    text: result.value.trim(),
    format: "docx",
    warnings,
  };
}

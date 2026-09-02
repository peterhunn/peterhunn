// Document field extractor. Given the raw bytes of an uploaded
// file, propose a structured DocumentData shape the manager can
// review before it's promoted onto the graph node.
//
// Two live paths:
//   text (application/pdf) → pdf-parse gets the text layer; a
//     text-only Anthropic Messages call extracts fields from it.
//     Cheap, deterministic, no vision tokens.
//   vision (image/*) → Anthropic Messages with an image content
//     block (Claude has vision).
//
// Both fall back to a deterministic mock stamped with a visible
// reason so nothing is silent (no API key, unsupported mime,
// scanned PDF with no text layer, fetch failure, non-2xx). The
// mock uses a filename hint for the title so even without AI the
// review card shows something plausible.
//
// We deliberately don't route through the model router today —
// vision + PDF binaries aren't first-class in ModelCall yet.
// Extraction is called from the upload route; the result rides on
// the response as a *proposal*, not an auto-write.

import pdfParse from "pdf-parse";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-opus-4-5-20251015";

export interface ExtractedDocumentFields {
  readonly title?: string;
  readonly category?: "identity" | "legal" | "policy" | "record" | "receipt" | "other";
  readonly expiresAt?: string;
  readonly issuer?: string;
  readonly subject?: string;
  readonly notes?: string;
}

export interface DocumentExtractionResult {
  readonly provider: "anthropic" | "mock";
  readonly reason?: string;
  readonly proposed: ExtractedDocumentFields;
  readonly rawText?: string;
}

const SUPPORTED_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const isSupportedForVision = (mime: string): boolean =>
  SUPPORTED_IMAGE_MIME.has(mime.toLowerCase());

const isPdf = (mime: string): boolean =>
  mime.toLowerCase() === "application/pdf";

const SYSTEM_PROMPT = [
  "You are extracting structured fields from a household document",
  "(a passport, driver's license, insurance policy, tax form, receipt,",
  "or similar). Look at the input and return one JSON object with any",
  "of these fields you can identify:",
  "  title      short human name for the document",
  "  category   identity | legal | policy | record | receipt | other",
  "  expiresAt  ISO 8601 datetime if the document has an expiration",
  "  issuer     the organization that issued it",
  "  subject    the person the document is about",
  "  notes      one short line of anything else notable",
  "Return JSON only. Omit any field you can't identify with confidence.",
].join(" ");

const tryParseFields = (text: string): ExtractedDocumentFields => {
  const start = text.indexOf("{");
  if (start < 0) return {};
  for (let end = text.length; end > start; end--) {
    if (text.charAt(end - 1) !== "}") continue;
    const slice = text.slice(start, end);
    try {
      const parsed = JSON.parse(slice) as ExtractedDocumentFields;
      return parsed;
    } catch {
      /* keep shrinking */
    }
  }
  return {};
};

const filenameHint = (filename: string | undefined): string | undefined => {
  if (!filename) return undefined;
  const base = filename.replace(/\.[^.]+$/, "").replace(/[_\-]+/g, " ").trim();
  if (!base) return undefined;
  return base.charAt(0).toUpperCase() + base.slice(1);
};

const mockExtract = (input: {
  filename?: string;
  reason: string;
}): DocumentExtractionResult => ({
  provider: "mock",
  reason: input.reason,
  proposed: {
    ...(filenameHint(input.filename) ? { title: filenameHint(input.filename)! } : {}),
  },
});

// Shared Anthropic caller. Takes the message content blocks and
// returns the parsed proposal, or a mock fallback on any error.
const callAnthropic = async (input: {
  apiKey: string;
  model: string;
  content: Array<Record<string, unknown>>;
  filename?: string;
  logger?: { info: (msg: string, ctx?: unknown) => void };
}): Promise<DocumentExtractionResult> => {
  const body = {
    model: input.model,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: input.content }],
  };
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    input.logger?.info("document extract fetch failed — mock fallback", {
      error: (err as Error).message,
    });
    return mockExtract({
      ...(input.filename ? { filename: input.filename } : {}),
      reason: `anthropic_fetch: ${(err as Error).message}`,
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    input.logger?.info("document extract non-2xx — mock fallback", {
      status: res.status,
      body: text.slice(0, 200),
    });
    return mockExtract({
      ...(input.filename ? { filename: input.filename } : {}),
      reason: `anthropic_${res.status}`,
    });
  }
  const json = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const rawText = (json.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
  return {
    provider: "anthropic",
    proposed: tryParseFields(rawText),
    rawText,
  };
};

export interface ExtractDocumentInput {
  readonly bytes: Buffer;
  readonly mime: string;
  readonly filename?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly logger?: { info: (msg: string, ctx?: unknown) => void };
}

export const extractDocumentFields = async (
  input: ExtractDocumentInput,
): Promise<DocumentExtractionResult> => {
  const apiKey = input.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  const model = input.model ?? DEFAULT_MODEL;

  if (!apiKey) {
    return mockExtract({
      ...(input.filename ? { filename: input.filename } : {}),
      reason: "no_anthropic_api_key",
    });
  }

  // PDF path — text layer via pdf-parse, then a text-only LLM
  // call. Scanned PDFs (no text layer) fall back to mock so the
  // manager knows the file needs OCR before extraction is useful.
  if (isPdf(input.mime)) {
    let parsedText: string;
    try {
      const parsed = await pdfParse(input.bytes);
      parsedText = (parsed.text ?? "").trim();
    } catch (err) {
      input.logger?.info("pdf-parse failed — mock fallback", {
        error: (err as Error).message,
      });
      return mockExtract({
        ...(input.filename ? { filename: input.filename } : {}),
        reason: `pdf_parse: ${(err as Error).message}`,
      });
    }
    if (!parsedText) {
      return mockExtract({
        ...(input.filename ? { filename: input.filename } : {}),
        reason: "pdf_no_text_extractable",
      });
    }
    // Cap the text sent to the model so a giant PDF doesn't blow
    // the context. 12k chars is ~3k tokens — comfortably under
    // any tier limit and enough for the first few pages where
    // identity fields typically live.
    const capped = parsedText.slice(0, 12_000);
    return callAnthropic({
      apiKey,
      model,
      content: [
        {
          type: "text",
          text: `Extract fields from the following document text. Return JSON only.\n\n---\n${capped}\n---`,
        },
      ],
      ...(input.filename ? { filename: input.filename } : {}),
      ...(input.logger ? { logger: input.logger } : {}),
    });
  }

  // Image path — vision content block.
  if (isSupportedForVision(input.mime)) {
    return callAnthropic({
      apiKey,
      model,
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: input.mime,
            data: input.bytes.toString("base64"),
          },
        },
        { type: "text", text: "Extract fields from this document. Return JSON only." },
      ],
      ...(input.filename ? { filename: input.filename } : {}),
      ...(input.logger ? { logger: input.logger } : {}),
    });
  }

  return mockExtract({
    ...(input.filename ? { filename: input.filename } : {}),
    reason: `unsupported_mime: ${input.mime}`,
  });
};

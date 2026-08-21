// Document field extractor. Given the raw bytes of an uploaded
// file, propose a structured DocumentData shape the manager can
// review before it's promoted onto the graph node.
//
// Live path: Anthropic Messages API with an image content block
// (Claude has vision). Requires ANTHROPIC_API_KEY. Falls back to a
// deterministic mock stamped with a visible reason so the fallback
// is never silent.
//
// We deliberately don't route through the model router today —
// image content blocks aren't first-class in ModelCall yet.
// Extraction is called from apps/api/src/routes/document-files.ts
// immediately after a successful upload; the result is returned
// inline in the upload response as a *proposal*, not an auto-write.
// The manager reviews and accepts via PATCH.

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

const SYSTEM_PROMPT = [
  "You are extracting structured fields from a household document",
  "(a passport, driver's license, insurance policy, tax form, receipt,",
  "or similar). Look at the image and return one JSON object with any",
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
  // The model often wraps JSON in prose or fences. Grab the first
  // {...} block that parses.
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
  // "US Passport Alex" → "US Passport Alex"
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
  if (!apiKey) {
    return mockExtract({
      ...(input.filename ? { filename: input.filename } : {}),
      reason: "no_anthropic_api_key",
    });
  }
  if (!isSupportedForVision(input.mime)) {
    return mockExtract({
      ...(input.filename ? { filename: input.filename } : {}),
      reason: `unsupported_mime: ${input.mime}`,
    });
  }

  const model = input.model ?? DEFAULT_MODEL;
  const body = {
    model,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: input.mime,
              data: input.bytes.toString("base64"),
            },
          },
          {
            type: "text" as const,
            text: "Extract fields from this document. Return JSON only.",
          },
        ],
      },
    ],
  };

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
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
  const proposed = tryParseFields(rawText);
  return {
    provider: "anthropic",
    proposed,
    rawText,
  };
};

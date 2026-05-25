/**
 * hashTemplate — fetch a contract template and return the hex SHA-256 of its
 * extracted text content.
 *
 * Use this to generate the templateHash for ContractRequirements before
 * publishing. Pass the same extractText function you'll give to ContractClient
 * so the client's hash verification always matches.
 *
 * Usage:
 *   import { hashTemplate, createExtractor } from "@x490/agents";
 *   const extract = createExtractor();
 *   const templateHash = await hashTemplate("https://example.com/nda.docx", extract);
 *   // use templateHash in ContractRequirements.templateHash
 */
export async function hashTemplate(
  url: string,
  extractText?: (content: ArrayBuffer, contentType: string, url: string) => Promise<string>,
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`hashTemplate: failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const bytes = await res.arrayBuffer();
  const contentType = res.headers.get("content-type") ?? "text/plain";
  const text = extractText
    ? await extractText(bytes, contentType, url)
    : new TextDecoder().decode(bytes);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

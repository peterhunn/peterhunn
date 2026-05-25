/**
 * createExtractor — returns an extractText function for use with ContractClient
 * and AgentContractClient.
 *
 * Dynamically imports mammoth (.docx) and pdfjs-dist (.pdf) so they are only
 * loaded when the relevant content type is encountered. Falls back to UTF-8
 * text decoding for plain text, Markdown, and HTML.
 *
 * Usage:
 *   import { createExtractor } from "@x490/agents";
 *   const client = new AgentContractClient({
 *     partyData: { name: "Agent" },
 *     extractText: createExtractor(),
 *   });
 */
export function createExtractor(): (content: ArrayBuffer, contentType: string, url: string) => Promise<string> {
  return async (content: ArrayBuffer, contentType: string, url: string): Promise<string> => {
    const ct = contentType.toLowerCase();
    const urlWithoutQuery = url.split("?")[0] ?? "";
    const ext = urlWithoutQuery.split(".").pop()?.toLowerCase() ?? "";

    // .docx
    if (ct.includes("wordprocessingml") || ct.includes("officedocument.wordprocessing") || ext === "docx") {
      try {
        // mammoth exports as CommonJS: `export = mammoth`
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mammothMod = (await import("mammoth")) as any;
        const mammoth = mammothMod.default ?? mammothMod;
        const result = await (mammoth as { extractRawText: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> }).extractRawText({ arrayBuffer: content });
        return result.value;
      } catch (e) {
        throw new Error(`x490: .docx extraction failed — is mammoth installed? (${e})`);
      }
    }

    // .pdf
    if (ct.includes("pdf") || ext === "pdf") {
      try {
        const pdfjsLib = await import("pdfjs-dist");
        (pdfjsLib.GlobalWorkerOptions as { workerSrc: string | false }).workerSrc = "";
        const loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(content),
          useWorkerFetch: false,
          useSystemFonts: true,
        });
        const pdf = await loadingTask.promise;
        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          const pageText = textContent.items
            .map((item) => ("str" in item ? (item as { str: string }).str : ""))
            .join(" ");
          pages.push(pageText);
        }
        return pages.join("\n");
      } catch (e) {
        throw new Error(`x490: PDF extraction failed — is pdfjs-dist installed? (${e})`);
      }
    }

    return new TextDecoder().decode(content);
  };
}

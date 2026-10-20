import { agentRuntime } from "@/lib/agent/runtime";
import type { LiveDocument } from "@/lib/server/hub";
import { log } from "@/lib/server/log";
import { pagesLeft, type PdfImportRecord } from "@/lib/server/pdfImports";

/**
 * Claude rebuilding an imported PDF as an editable document: a chat on the
 * document that starts with the request to convert it, which the PDF tools
 * (lib/agent/pdfTools.ts) carry out page by page. The user watches it in the
 * Claude panel, and can stop, steer or continue it like any chat.
 */

/** Tool rounds for one conversion message: about ten a page (read, crop figures, write, compare, fix). */
export function conversionMaxTurns(pages: number) {
  return Math.min(1000, Math.max(100, pages * 10 + 30));
}

export function conversionRequest(record: PdfImportRecord, pages: number[]) {
  const all = pages.length === record.manifest.pageCount;
  const which = all ? `all ${pages.length} page${pages.length === 1 ? "" : "s"}` : `page${pages.length === 1 ? "" : "s"} ${pages.join(", ")}`;
  return `Convert the PDF I imported (“${record.fileName}”) into an editable document: rebuild ${which} in Inline's format, as close to the original as you can get it. Leave out the handwritten annotations; I can show those over the pages myself.`;
}

/** The model a conversion runs on: Opus, thinking at medium effort (reading equations off a page and judging layout pay for it). */
export const CONVERSION_MODEL = { model: "opus", effort: "medium" } as const;

/** Start (or restart) the conversion in a new chat on the document. Returns the chat's id. */
export async function startPdfConversion(doc: LiveDocument, record: PdfImportRecord, options: { pages?: number[] } = {}) {
  const left = options.pages?.length ? options.pages : pagesLeft(doc.doc, record.manifest.pageCount);
  const pages = left.length ? left : record.manifest.pages.map((page) => page.page);
  const runtime = agentRuntime();
  const providerSettings = runtime.defaultSettings.provider === "codex" ? { provider: "codex" as const, model: runtime.defaultSettings.model, effort: runtime.defaultSettings.effort } : { provider: "claude" as const, ...CONVERSION_MODEL };
  const chat = await runtime.create({ documentId: doc.id, settings: { ...providerSettings, maxTurns: conversionMaxTurns(pages.length) } });
  doc.setPdfImport({ status: "converting", chatId: chat.state.id });
  void chat.send({ text: conversionRequest(record, pages), documentId: doc.id }).catch((error) => {
    log("warn", "the PDF conversion couldn't start", { documentId: doc.id, error });
    doc.setPdfImport({ status: "pending" });
  });
  return chat.state.id;
}

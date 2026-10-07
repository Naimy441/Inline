import { documentToDocx } from "@/lib/doc/docx";
import { docPlainText } from "@/lib/doc/editing";
import { documentHtmlFile } from "@/lib/doc/html";
import { docToMarkdown } from "@/lib/doc/markdown";
import { rejectHunks } from "@/lib/doc/review";
import { joinTabs } from "@/lib/doc/tabs";
import { HttpError, route, routeDocument } from "@/lib/server/http";
import { documentHub, type LiveDocument } from "@/lib/server/hub";
import { loadImage } from "@/lib/server/images";

type Context = { params: Promise<{ id: string }> };

const TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  html: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
} as const;

function filename(title: string, extension: string) {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").trim() || "Untitled document";
  return `${base}.${extension}`;
}

export const GET = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const format = new URL(request.url).searchParams.get("format") ?? "docx";
  if (!(format in TYPES)) throw new HttpError(400, "Unsupported format. Use docx, html, md or txt.");
  // Pending changes are part of the text by default; ?changes=without exports the text as it was before them.
  const changes = new URL(request.url).searchParams.get("changes") ?? "with";
  if (changes !== "with" && changes !== "without") throw new HttpError(400, "changes must be with or without.");
  const textOf = (tab: LiveDocument) => (changes === "without" && tab.hunks.length ? rejectHunks(tab.doc, tab.hunks, "all").tr.doc : tab.doc);
  // ?tabs=all exports every tab of the document in order, each starting on a new page.
  const all = new URL(request.url).searchParams.get("tabs") === "all";
  const tabs = all ? (await documentHub().family(doc.id)).tabs : [doc];
  const content = joinTabs(tabs.map(textOf));
  let body: BodyInit;
  if (format === "docx") body = (await documentToDocx(content, doc.meta, loadImage)) as Uint8Array<ArrayBuffer>;
  else if (format === "html") body = documentHtmlFile(content, doc.meta);
  else if (format === "md") body = docToMarkdown(content);
  else body = docPlainText(content);
  const name = filename(doc.meta.title, format);
  return new Response(body, {
    headers: {
      "Content-Type": TYPES[format as keyof typeof TYPES],
      "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
    },
  });
});

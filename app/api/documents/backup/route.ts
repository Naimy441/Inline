import { docToMarkdown } from "@/lib/doc/markdown";
import { createZip, type ZipEntry } from "@/lib/doc/zip";
import { route } from "@/lib/server/http";
import { documentHub, loadDoc } from "@/lib/server/hub";
import { listDocumentIds, readDocumentFile } from "@/lib/server/store";

/**
 * Every document in one ZIP: a readable Markdown copy of each, plus the full
 * Inline files (formatting, comments, pending changes) under inline-data/
 * for a complete backup. Trashed documents are included in trash/.
 */
export const GET = route(async () => {
  const hub = documentHub();
  await hub.flushAll();
  const entries: ZipEntry[] = [];
  const used = new Set<string>();
  for (const id of await listDocumentIds()) {
    const file = await readDocumentFile(id).catch(() => null);
    if (!file) continue;
    entries.push({ name: `inline-data/documents/${id}.json`, data: JSON.stringify(file) });
    const base = (file.meta.title || "Untitled document").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").trim().slice(0, 100) || "Untitled document";
    const folder = file.meta.trashedAt ? "trash/" : "";
    let name = `${folder}${base}.md`;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${folder}${base} (${n}).md`;
    used.add(name.toLowerCase());
    entries.push({ name, data: docToMarkdown(loadDoc(file.doc)) });
  }
  const date = new Date().toISOString().slice(0, 10);
  return new Response(new Uint8Array(createZip(entries)), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="inline-backup-${date}.zip"`,
      "Cache-Control": "no-store",
    },
  });
});

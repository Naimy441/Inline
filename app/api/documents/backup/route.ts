import { docToMarkdown } from "@/lib/doc/markdown";
import { folderPath } from "@/lib/doc/folders";
import { createZip, type ZipEntry } from "@/lib/doc/zip";
import { listFolders } from "@/lib/server/folders";
import { route } from "@/lib/server/http";
import { documentHub, loadDoc } from "@/lib/server/hub";
import { listDocumentIds, readDocumentFile } from "@/lib/server/store";

/**
 * Every document in one ZIP: a readable Markdown copy of each, plus the full
 * Inline files (formatting, comments, pending changes) under inline-data/
 * for a complete backup. Markdown copies sit in folders matching Inline's;
 * trashed documents are included in trash/.
 */
export const GET = route(async () => {
  const hub = documentHub();
  await hub.flushAll();
  const entries: ZipEntry[] = [];
  const used = new Set<string>();
  const folderList = await listFolders();
  const folders = new Map(folderList.map((folder) => [folder.id, folder]));
  const safe = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").trim().slice(0, 100);
  entries.push({ name: "inline-data/folders.json", data: JSON.stringify({ folders: folderList }) });
  const files = [];
  for (const id of await listDocumentIds()) {
    const file = await readDocumentFile(id).catch(() => null);
    if (file) files.push(file);
  }
  // Tabs are filed with their document, which names the folder.
  const rootFolder = new Map(files.map((file) => [file.meta.id, file.meta.folderId]));
  for (const file of files) {
    const id = file.meta.id;
    entries.push({ name: `inline-data/documents/${id}.json`, data: JSON.stringify(file) });
    // Tabs after the first are saved beside it, named for their tab.
    const title = file.meta.parentId ? `${file.meta.title || "Untitled document"} - ${file.meta.tabTitle || "Tab"}` : file.meta.title || "Untitled document";
    const base = safe(title) || "Untitled document";
    const folderId = file.meta.parentId ? rootFolder.get(file.meta.parentId) : file.meta.folderId;
    const location = folderPath(folders, folderId).map((folder) => `${safe(folder.name) || "Folder"}/`).join("");
    const folder = `${file.meta.trashedAt ? "trash/" : ""}${location}`;
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

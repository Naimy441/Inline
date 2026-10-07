import { randomUUID } from "node:crypto";
import { docxTitle, readDocx, DocxImportError } from "@/lib/doc/docxImport";
import type { DocumentMeta } from "@/lib/doc/settings";
import { HttpError, json, route } from "@/lib/server/http";
import { MAX_FOLDER_DEPTH } from "@/lib/doc/folders";
import { ensureFolderPath, folderExists } from "@/lib/server/folders";
import { saveFont } from "@/lib/server/fonts";
import { documentHub } from "@/lib/server/hub";
import { saveUpload, uploadExtension } from "@/lib/server/store";
import { archiveFolders, openZip, readZip, ZipError } from "@/lib/server/unzip";

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);


/**
 * Create a document from a .docx package, with its page setup, fonts, header
 * and footer, and comments. Embedded images become uploads; a Google Doc's
 * tabs become tabs.
 */
async function importDocx(data: Uint8Array, fileName: string, folderId: string | null, options: { preferFileName?: boolean } = {}) {
  let imported;
  let parts;
  try {
    parts = readZip(data);
    imported = await readDocx(parts, {
      saveImage: async (image, mime) => {
        const extension = uploadExtension(mime);
        if (!extension) return null;
        const id = randomUUID().replace(/-/g, "");
        await saveUpload(id, extension, image);
        return `/api/uploads/${id}.${extension}`;
      },
      // The fonts the file carries, so the page shows it in them.
      saveFont: async (font) => {
        await saveFont(font);
      },
    });
  } catch (error) {
    if (error instanceof ZipError || error instanceof DocxImportError) throw new HttpError(422, `This file couldn't be read as a Word document. ${error.message}`);
    throw error;
  }
  // Google Takeout names each file after its Google Doc, which is a better title than the file's own properties.
  const named = fileName.replace(/\.docx$/i, "").trim();
  const title = (options.preferFileName && named) || docxTitle(parts) || named || "Imported document";
  const hub = documentHub();
  const [first, ...rest] = imported.tabs;
  const tabName = (tab: { title: string | null }, index: number) => (imported.tabs.length > 1 ? tab.title || `Tab ${index + 1}` : undefined);
  const root = await hub.create({ title, doc: first!.doc.toJSON(), settings: imported.settings, comments: first!.comments, folderId, tabTitle: tabName(first!, 0) });
  if (rest.length) {
    const ids = [root.id];
    for (const [index, tab] of rest.entries()) {
      ids.push((await hub.create({ title: root.meta.title, doc: tab.doc.toJSON(), settings: imported.settings, comments: tab.comments, parentId: root.id, tabTitle: tabName(tab, index + 1) })).id);
    }
    root.setTabMeta({ tabs: ids });
  }
  return root;
}

/**
 * Import every Word document in a ZIP, such as a Google Takeout export of
 * Google Drive (Takeout saves each Google Doc as a .docx). Other files in the
 * archive are skipped; a document that can't be read doesn't stop the rest.
 */
async function importArchive(data: Uint8Array, folderId: string | null) {
  let entries;
  try {
    entries = openZip(data);
  } catch (error) {
    if (error instanceof ZipError) throw new HttpError(422, `This file couldn't be read as a ZIP archive. ${error.message}`);
    throw error;
  }
  const names = [...entries.keys()]
    .filter((name) => /\.docx$/i.test(name) && !name.startsWith("__MACOSX/") && !baseName(name).startsWith("~$"))
    .sort((a, b) => a.localeCompare(b));
  if (!names.length) throw new HttpError(422, "No Word (.docx) files were found in this ZIP. In Google Takeout, choose Drive and keep Google Docs exporting as DOCX.");
  const documents: DocumentMeta[] = [];
  const failed: { name: string; error: string }[] = [];
  // Drive's folders come along: each document lands in the same folders it had, inside the one being imported into.
  const folders = archiveFolders(names);
  const made = new Map<string, string | null>();
  for (const name of names) {
    try {
      const path = folders.get(name)!.slice(0, MAX_FOLDER_DEPTH - 1);
      const key = path.join("/");
      if (!made.has(key)) made.set(key, path.length ? ((await ensureFolderPath(path, { parentId: folderId }).catch(() => null))?.folder?.id ?? folderId) : folderId);
      const live = await importDocx(entries.get(name)!(), baseName(name), made.get(key) ?? folderId, { preferFileName: true });
      documents.push(live.snapshot().meta);
    } catch (error) {
      if (error instanceof HttpError) failed.push({ name, error: error.message });
      else if (error instanceof ZipError) failed.push({ name, error: `This file couldn't be read as a Word document. ${error.message}` });
      else throw error;
    }
  }
  if (!documents.length) throw new HttpError(422, `None of the ${names.length} Word files in this ZIP could be read.`, { failed });
  return json({ documents, failed, folders: [...made.values()].filter((id) => id && id !== folderId).length }, { status: 201 });
}

/**
 * Import a Word document (.docx) as a new Inline document, or a ZIP of them
 * (a Google Takeout export, for example) as one new document per file.
 * An optional "folderId" field files them in that folder.
 */
export const POST = route(async (request) => {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new HttpError(400, 'Send the file as multipart form field "file".');
  const folder = form?.get("folderId");
  const folderId = typeof folder === "string" && folder ? folder : null;
  if (folderId && !(await folderExists(folderId))) throw new HttpError(404, "That folder was not found.");
  if (/\.zip$/i.test(file.name)) {
    if (file.size > MAX_ARCHIVE_BYTES) throw new HttpError(413, "ZIP archives can be up to 1 GB. In Google Takeout, pick a smaller archive size to split the export.");
    return importArchive(new Uint8Array(await file.arrayBuffer()), folderId);
  }
  if (file.size > MAX_IMPORT_BYTES) throw new HttpError(413, "Word files can be up to 50 MB.");
  if (!/\.docx$/i.test(file.name)) throw new HttpError(415, "Only Word (.docx) files and ZIP archives of them can be imported here. Older .doc files need saving as .docx first.");
  const live = await importDocx(new Uint8Array(await file.arrayBuffer()), file.name, folderId);
  return json({ document: live.snapshot() }, { status: 201 });
});

import { randomUUID } from "node:crypto";
import { docxTitle, docxToDoc, DocxImportError } from "@/lib/doc/docxImport";
import type { DocumentMeta } from "@/lib/doc/settings";
import { HttpError, json, route } from "@/lib/server/http";
import { documentHub } from "@/lib/server/hub";
import { saveUpload, uploadExtension } from "@/lib/server/store";
import { openZip, readZip, ZipError } from "@/lib/server/unzip";

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Create a document from a .docx package. Embedded images become uploads. */
async function importDocx(data: Uint8Array, fileName: string) {
  let doc;
  let parts;
  try {
    parts = readZip(data);
    doc = await docxToDoc(parts, {
      saveImage: async (image, mime) => {
        const extension = uploadExtension(mime);
        if (!extension) return null;
        const id = randomUUID().replace(/-/g, "");
        await saveUpload(id, extension, image);
        return `/api/uploads/${id}.${extension}`;
      },
    });
  } catch (error) {
    if (error instanceof ZipError || error instanceof DocxImportError) throw new HttpError(422, `This file couldn't be read as a Word document. ${error.message}`);
    throw error;
  }
  const title = docxTitle(parts) || fileName.replace(/\.docx$/i, "") || "Imported document";
  return documentHub().create({ title, doc: doc.toJSON() });
}

/**
 * Import every Word document in a ZIP, such as a Google Takeout export of
 * Google Drive (Takeout saves each Google Doc as a .docx). Other files in the
 * archive are skipped; a document that can't be read doesn't stop the rest.
 */
async function importArchive(data: Uint8Array) {
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
  for (const name of names) {
    try {
      const live = await importDocx(entries.get(name)!(), baseName(name));
      documents.push(live.snapshot().meta);
    } catch (error) {
      if (error instanceof HttpError) failed.push({ name, error: error.message });
      else if (error instanceof ZipError) failed.push({ name, error: `This file couldn't be read as a Word document. ${error.message}` });
      else throw error;
    }
  }
  if (!documents.length) throw new HttpError(422, `None of the ${names.length} Word files in this ZIP could be read.`, { failed });
  return json({ documents, failed }, { status: 201 });
}

/**
 * Import a Word document (.docx) as a new Inline document, or a ZIP of them
 * (a Google Takeout export, for example) as one new document per file.
 */
export const POST = route(async (request) => {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new HttpError(400, 'Send the file as multipart form field "file".');
  if (/\.zip$/i.test(file.name)) {
    if (file.size > MAX_ARCHIVE_BYTES) throw new HttpError(413, "ZIP archives can be up to 1 GB. In Google Takeout, pick a smaller archive size to split the export.");
    return importArchive(new Uint8Array(await file.arrayBuffer()));
  }
  if (file.size > MAX_IMPORT_BYTES) throw new HttpError(413, "Word files can be up to 50 MB.");
  if (!/\.docx$/i.test(file.name)) throw new HttpError(415, "Only Word (.docx) files and ZIP archives of them can be imported here. Older .doc files need saving as .docx first.");
  const live = await importDocx(new Uint8Array(await file.arrayBuffer()), file.name);
  return json({ document: live.snapshot() }, { status: 201 });
});

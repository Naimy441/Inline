import { randomUUID } from "node:crypto";
import { docxTitle, docxToDoc, DocxImportError } from "@/lib/doc/docxImport";
import { HttpError, json, route } from "@/lib/server/http";
import { documentHub } from "@/lib/server/hub";
import { saveUpload, uploadExtension } from "@/lib/server/store";
import { readZip, ZipError } from "@/lib/server/unzip";

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/** Import a Word document (.docx) as a new Inline document. Embedded images become uploads. */
export const POST = route(async (request) => {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new HttpError(400, 'Send the file as multipart form field "file".');
  if (file.size > MAX_IMPORT_BYTES) throw new HttpError(413, "Word files can be up to 50 MB.");
  if (!/\.docx$/i.test(file.name)) throw new HttpError(415, "Only Word (.docx) files can be imported here. Older .doc files need saving as .docx first.");
  let doc;
  let parts;
  try {
    parts = readZip(new Uint8Array(await file.arrayBuffer()));
    doc = await docxToDoc(parts, {
      saveImage: async (data, mime) => {
        const extension = uploadExtension(mime);
        if (!extension) return null;
        const id = randomUUID().replace(/-/g, "");
        await saveUpload(id, extension, data);
        return `/api/uploads/${id}.${extension}`;
      },
    });
  } catch (error) {
    if (error instanceof ZipError || error instanceof DocxImportError) throw new HttpError(422, `This file couldn't be read as a Word document. ${error.message}`);
    throw error;
  }
  const title = docxTitle(parts) || file.name.replace(/\.docx$/i, "") || "Imported document";
  const live = await documentHub().create({ title, doc: doc.toJSON() });
  return json({ document: live.snapshot() }, { status: 201 });
});

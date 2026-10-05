import { randomUUID } from "node:crypto";
import { HttpError, json, route } from "@/lib/server/http";
import { saveUpload, uploadExtension } from "@/lib/server/store";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Store an image or file (for documents or chat attachments) and return its URL. */
export const POST = route(async (request) => {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Send the file as multipart form field \"file\".");
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "Files can be up to 25 MB.");
  const mime = file.type || (file.name.endsWith(".md") ? "text/markdown" : "application/octet-stream");
  const extension = uploadExtension(mime);
  if (!extension) throw new HttpError(415, "That file type isn't supported. Use an image, PDF, or text file.");
  const id = randomUUID().replace(/-/g, "");
  await saveUpload(id, extension, new Uint8Array(await file.arrayBuffer()));
  const kind = mime.startsWith("image/") ? "image" : mime === "application/pdf" ? "pdf" : "text";
  return json({ id, url: `/api/uploads/${id}.${extension}`, name: file.name, mime, size: file.size, kind }, { status: 201 });
});

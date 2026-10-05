import { readFile } from "node:fs/promises";
import type { ImageLoader } from "@/lib/doc/docx";
import { findUpload, mimeForExtension } from "@/lib/server/store";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** Load an image referenced by a document (data URL, Inline upload or web URL) for export. */
export const loadImage: ImageLoader = async (src) => {
  try {
    if (src.startsWith("data:")) {
      const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
      if (!match) return null;
      const data = match[2] ? Buffer.from(match[3]!, "base64") : Buffer.from(decodeURIComponent(match[3]!), "utf8");
      return { data: new Uint8Array(data), mime: match[1]! };
    }
    const upload = /^\/api\/uploads\/([A-Za-z0-9_-]+)(?:\.\w+)?$/.exec(src);
    if (upload) {
      const found = await findUpload(upload[1]!);
      if (!found) return null;
      return { data: new Uint8Array(await readFile(found.file)), mime: mimeForExtension(found.extension) };
    }
    if (/^https?:\/\//i.test(src)) {
      const response = await fetch(src, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) return null;
      const mime = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (!mime.startsWith("image/")) return null;
      const buffer = new Uint8Array(await response.arrayBuffer());
      return buffer.byteLength > MAX_IMAGE_BYTES ? null : { data: buffer, mime };
    }
  } catch {
    return null;
  }
  return null;
};

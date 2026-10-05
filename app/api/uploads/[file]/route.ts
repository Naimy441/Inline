import { readFile } from "node:fs/promises";
import { notFound, route } from "@/lib/server/http";
import { findUpload, mimeForExtension } from "@/lib/server/store";

type Context = { params: Promise<{ file: string }> };

export const GET = route(async (_request, context: Context) => {
  const { file } = await context.params;
  const id = file.replace(/\.\w+$/, "");
  const found = await findUpload(id);
  if (!found) throw notFound("Upload not found.");
  const mime = mimeForExtension(found.extension);
  return new Response(new Uint8Array(await readFile(found.file)), {
    headers: {
      "Content-Type": mime,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      // Uploaded SVG or HTML must never run script in Inline's origin.
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    },
  });
});

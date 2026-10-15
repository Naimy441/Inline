import { readFile } from "node:fs/promises";
import path from "node:path";
import { notFound, route } from "@/lib/server/http";

/**
 * The data pdf.js reads while importing a PDF in the browser
 * (lib/pdf/import/prepare.ts): character maps for Chinese, Japanese and
 * Korean fonts, the standard fonts a PDF may name without embedding, the
 * decoders for JPEG 2000 and JBIG2 pictures, and a color profile. They are
 * served from the pdfjs-dist package (next.config.mjs keeps them in the
 * desktop app's server).
 */

const FOLDERS = new Set(["cmaps", "standard_fonts", "wasm", "iccs"]);

const TYPES: Record<string, string> = {
  bcmap: "application/octet-stream",
  pfb: "application/octet-stream",
  ttf: "font/ttf",
  wasm: "application/wasm",
  js: "text/javascript",
  icc: "application/vnd.iccprofile",
};

type Context = { params: Promise<{ path: string[] }> };

export const GET = route(async (_request, context: Context) => {
  const parts = (await context.params).path;
  const [folder, file, ...rest] = parts;
  if (!folder || !file || rest.length || !FOLDERS.has(folder) || !/^[\w.-]+$/.test(file) || file.startsWith(".")) throw notFound("Not found.");
  const type = TYPES[file.slice(file.lastIndexOf(".") + 1).toLowerCase()];
  if (!type) throw notFound("Not found.");
  const root = path.join(/* turbopackIgnore: true */ process.cwd(), "node_modules", "pdfjs-dist", folder);
  const data = await readFile(path.join(root, file)).catch(() => null);
  if (!data) throw notFound("Not found.");
  return new Response(new Uint8Array(data), {
    headers: { "Content-Type": type, "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" },
  });
});

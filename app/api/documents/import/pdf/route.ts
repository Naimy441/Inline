import { z } from "zod";
import { startPdfConversion } from "@/lib/agent/pdfConversion";
import type { PdfImportManifest } from "@/lib/pdf/import/types";
import { folderExists } from "@/lib/server/folders";
import { HttpError, json, route } from "@/lib/server/http";
import { createPdfImport, PdfImportError } from "@/lib/server/pdfImports";

const MAX_PDF_BYTES = 200 * 1024 * 1024;

const box = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

/** The parts of the manifest the server relies on; the rest is passed through as the browser wrote it. */
const ManifestSchema = z
  .object({
    version: z.literal(1),
    fileName: z.string().max(500),
    title: z.string().max(500).nullable(),
    pageCount: z.number().int().min(1).max(1000),
    renderScale: z.number().min(0.5).max(8),
    pages: z
      .array(
        z
          .object({
            page: z.number().int().min(1),
            width: z.number().positive(),
            height: z.number().positive(),
            lines: z.array(z.object({ text: z.string(), box, baseline: z.number(), size: z.number() }).passthrough()),
            images: z.array(z.object({ id: z.string().max(40), box, asset: z.string().max(80).optional() }).passthrough()),
            ink: z.object({ count: z.number() }).passthrough(),
          })
          .passthrough(),
      )
      .min(1),
    summary: z
      .object({
        margins: z.object({ top: z.number(), right: z.number(), bottom: z.number(), left: z.number() }),
        bodyFont: z.string(),
        bodySize: z.number(),
        lineSpacing: z.number(),
        paragraphSpacing: z.number(),
      })
      .passthrough(),
    fonts: z.array(z.object({ name: z.string().min(1).max(200), field: z.string().regex(/^font-\d+$/), bold: z.boolean(), italic: z.boolean() })).max(100).optional(),
  })
  .passthrough();

/**
 * Import a PDF read and drawn by the browser (lib/pdf/import/prepare.ts): the
 * original file, a "manifest" describing its pages, and the page pictures
 * ("clean-N", "view-N", "ink-N") and pictures in it ("image-…"). Creates the
 * document, showing the original pages until Claude rebuilds them as text;
 * with "convert" set, Claude starts on that at once (its chat id is returned).
 */
export const POST = route(async (request) => {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const manifestFile = form?.get("manifest");
  if (!(file instanceof File) || !(manifestFile instanceof Blob)) throw new HttpError(400, 'Send the PDF as "file" and its manifest as "manifest".');
  if (file.size > MAX_PDF_BYTES) throw new HttpError(413, "PDFs can be up to 200 MB.");
  const folder = form?.get("folderId");
  const folderId = typeof folder === "string" && folder ? folder : null;
  if (folderId && !(await folderExists(folderId))) throw new HttpError(404, "That folder was not found.");
  let manifest: PdfImportManifest;
  try {
    const parsed = ManifestSchema.safeParse(JSON.parse(await manifestFile.text()));
    if (!parsed.success) throw new Error(parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    manifest = parsed.data as unknown as PdfImportManifest;
  } catch (error) {
    throw new HttpError(400, `The PDF's description couldn't be read: ${(error as Error).message}`);
  }
  if (manifest.pages.length !== manifest.pageCount) throw new HttpError(400, "The PDF's description doesn't match its pages.");
  const files = new Map<string, Uint8Array>();
  for (const [name, value] of form!.entries()) {
    if (name === "file" || name === "manifest" || !(value instanceof Blob)) continue;
    if (!/^(clean|view|ink)-\d+$|^image-\d+-\d+$|^font-\d+$/.test(name)) continue;
    files.set(name, new Uint8Array(await value.arrayBuffer()));
  }
  let created;
  try {
    created = await createPdfImport({ manifest, source: new Uint8Array(await file.arrayBuffer()), files: { get: (name) => files.get(name) ?? null }, folderId });
  } catch (error) {
    if (error instanceof PdfImportError) throw new HttpError(422, error.message);
    throw error;
  }
  const convert = form?.get("convert") === "1";
  const chatId = convert ? await startPdfConversion(created.doc, created.record) : null;
  return json({ document: created.doc.snapshot(), chatId }, { status: 201 });
});

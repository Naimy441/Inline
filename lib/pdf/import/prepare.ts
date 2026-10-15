import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { ANNOTATIONS_ON_CANVAS, analyzePage, captureOperatorList, settleInk, summarize, type AnalyzedPage } from "@/lib/pdf/import/analyze";
import { contentFilter, inkFilter } from "@/lib/pdf/import/classify";
import type { PdfImportManifest } from "@/lib/pdf/import/types";

/**
 * Gets a PDF ready to import, in the browser: pdf.js reads it (in a worker),
 * each page is analyzed (lib/pdf/import/analyze.ts) and drawn twice — the
 * page without its annotations, and its annotations alone on a transparent
 * page — and its pictures are taken out at their own resolution. All of it
 * goes to /api/documents/import/pdf in one form.
 */

/** Pixels per point of the stored page pictures: 216 dpi, sharp on a high-density screen and for cropping figures. */
export const RENDER_SCALE = 3;
/** Pixels per point of the page picture Claude reads (144 dpi). */
export const VIEW_SCALE = 2;
export const MAX_PDF_PAGES = 500;

export type PrepareProgress = { stage: "reading" | "pages" | "saving"; page?: number; pages?: number };

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let loading: Promise<PdfJs> | null = null;

/** pdf.js, with its worker started (once). The legacy build carries the polyfills older browsers need. */
export function loadPdfJs(): Promise<PdfJs> {
  loading ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
    if (!pdfjs.GlobalWorkerOptions.workerPort) {
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url), { type: "module" });
    }
    return pdfjs;
  });
  return loading;
}

/** Open a PDF; `close` frees it and its worker-side data. */
export async function openPdf(data: Uint8Array): Promise<{ pdf: PDFDocumentProxy; close: () => void }> {
  const pdfjs = await loadPdfJs();
  const base = `${location.origin}/api/pdfjs`;
  const task = pdfjs.getDocument({
    data,
    fontExtraProperties: true,
    cMapUrl: `${base}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}/standard_fonts/`,
    wasmUrl: `${base}/wasm/`,
    iccUrl: `${base}/iccs/`,
    verbosity: 0,
  } as Parameters<PdfJs["getDocument"]>[0]);
  return { pdf: await task.promise, close: () => void task.destroy() };
}

function canvas(width: number, height: number) {
  const element = document.createElement("canvas");
  element.width = Math.max(1, Math.ceil(width));
  element.height = Math.max(1, Math.ceil(height));
  return element;
}

function release(element: HTMLCanvasElement) {
  element.width = 0;
  element.height = 0;
}

function toBlob(element: HTMLCanvasElement, type = "image/png", quality?: number) {
  return new Promise<Blob>((resolve, reject) => element.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The page couldn't be drawn."))), type, quality));
}

async function draw(page: PDFPageProxy, scale: number, filter: (index: number) => boolean, transparent: boolean) {
  const viewport = page.getViewport({ scale });
  const target = canvas(viewport.width, viewport.height);
  const context = target.getContext("2d")!;
  await page.render({
    canvasContext: context,
    canvas: target,
    viewport,
    annotationMode: ANNOTATIONS_ON_CANVAS,
    background: transparent ? "rgba(0,0,0,0)" : "#ffffff",
    operationsFilter: filter,
  } as Parameters<PDFPageProxy["render"]>[0]).promise;
  return target;
}

/** Whether a picture is see-through anywhere, so it keeps PNG's transparency. */
function hasTransparency(context: CanvasRenderingContext2D, width: number, height: number) {
  const data = context.getImageData(0, 0, width, height).data;
  for (let i = 3; i < data.length; i += 16) if (data[i]! < 250) return true;
  return false;
}

type ImageObject = { width: number; height: number; bitmap?: CanvasImageSource; data?: Uint8ClampedArray | Uint8Array; kind?: number };

/** A picture pdf.js decoded for the page, as PNG (or JPEG for a large photo), or null. */
async function imageFile(page: PDFPageProxy, object: string): Promise<Blob | null> {
  if (!page.objs.has(object)) return null;
  const image = page.objs.get(object) as ImageObject | null;
  if (!image?.width || !image.height) return null;
  const target = canvas(image.width, image.height);
  const context = target.getContext("2d", { willReadFrequently: true })!;
  try {
    if (image.bitmap) context.drawImage(image.bitmap, 0, 0);
    else if (image.data) {
      const pixels = context.createImageData(image.width, image.height);
      const out = pixels.data;
      const source = image.data;
      const count = image.width * image.height;
      // pdf.js's image kinds: 1 is one bit per pixel (rows padded to bytes), 2 RGB, 3 RGBA.
      if (image.kind === 3) out.set(source.subarray(0, count * 4));
      else if (image.kind === 2) for (let i = 0, j = 0; i < count; i += 1, j += 3) (out[i * 4] = source[j]!), (out[i * 4 + 1] = source[j + 1]!), (out[i * 4 + 2] = source[j + 2]!), (out[i * 4 + 3] = 255);
      else if (image.kind === 1) {
        const row = Math.ceil(image.width / 8);
        for (let y = 0; y < image.height; y += 1)
          for (let x = 0; x < image.width; x += 1) {
            const on = (source[y * row + (x >> 3)]! >> (7 - (x & 7))) & 1;
            const i = (y * image.width + x) * 4;
            out[i] = out[i + 1] = out[i + 2] = on ? 255 : 0;
            out[i + 3] = 255;
          }
      } else return null;
      context.putImageData(pixels, 0, 0);
    } else return null;
    const photo = image.width * image.height > 1_200_000 && !hasTransparency(context, image.width, image.height);
    return await toBlob(target, photo ? "image/jpeg" : "image/png", photo ? 0.9 : undefined);
  } finally {
    release(target);
  }
}

function documentTitle(info: Record<string, unknown> | undefined, fileName: string) {
  const title = typeof info?.Title === "string" ? info.Title.trim() : "";
  // Titles some programs fill in by themselves ("Microsoft Word - report.docx", "untitled") say less than the file name.
  if (title && !/^(untitled|microsoft (word|powerpoint)\s*-|.*\.(docx?|tex|dvi|pptx?|pdf)$)/i.test(title)) return title.slice(0, 200);
  return null;
}

export class PdfImportError extends Error {}

/** Read and draw a PDF for import. Returns the form to send to /api/documents/import/pdf. */
export async function preparePdfImport(file: File, onProgress: (progress: PrepareProgress) => void = () => undefined): Promise<{ form: FormData; manifest: PdfImportManifest }> {
  onProgress({ stage: "reading" });
  let pdf: PDFDocumentProxy;
  let close: () => void;
  try {
    ({ pdf, close } = await openPdf(new Uint8Array(await file.arrayBuffer())));
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === "PasswordException") throw new PdfImportError("This PDF is protected with a password. Remove the password and import it again.");
    throw new PdfImportError(`This file couldn't be read as a PDF. ${(error as Error)?.message ?? ""}`.trim());
  }
  try {
    const pdfjs = await loadPdfJs();
    if (pdf.numPages > MAX_PDF_PAGES) throw new PdfImportError(`This PDF has ${pdf.numPages} pages; Inline imports up to ${MAX_PDF_PAGES}. Split it into smaller files first.`);
    const scratch = canvas(32, 32);
    const pages: Array<AnalyzedPage & { proxy: PDFPageProxy }> = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      onProgress({ stage: "reading", page: number, pages: pdf.numPages });
      const proxy = await pdf.getPage(number);
      const operatorList = await captureOperatorList(proxy, scratch);
      pages.push({ ...(await analyzePage(pdf, proxy, pdfjs.OPS, { operatorList })), proxy });
    }
    release(scratch);
    settleInk(pages);
    const form = new FormData();
    form.append("file", file);
    for (const page of pages) {
      const number = page.analysis.page;
      onProgress({ stage: "pages", page: number, pages: pages.length });
      const clean = await draw(page.proxy, RENDER_SCALE, contentFilter(page.classification), false);
      form.append(`clean-${number}`, await toBlob(clean), `clean-${number}.png`);
      const view = canvas((clean.width * VIEW_SCALE) / RENDER_SCALE, (clean.height * VIEW_SCALE) / RENDER_SCALE);
      const viewContext = view.getContext("2d")!;
      viewContext.imageSmoothingQuality = "high";
      viewContext.drawImage(clean, 0, 0, view.width, view.height);
      form.append(`view-${number}`, await toBlob(view), `view-${number}.png`);
      release(view);
      release(clean);
      if (page.analysis.ink.count) {
        const ink = await draw(page.proxy, RENDER_SCALE, inkFilter(page.classification), true);
        form.append(`ink-${number}`, await toBlob(ink), `ink-${number}.png`);
        release(ink);
      }
      // The page's pictures, once each, at their own resolution (decoded while the page was drawn).
      const saved = new Map<string, string | null>();
      for (const image of page.analysis.images) {
        if (!image.object) continue;
        if (!saved.has(image.object)) {
          const blob = await imageFile(page.proxy, image.object).catch(() => null);
          const field = blob ? `image-${number}-${saved.size + 1}` : null;
          if (blob && field) form.append(field, blob, `${field}.${blob.type === "image/jpeg" ? "jpg" : "png"}`);
          saved.set(image.object, field);
        }
        const field = saved.get(image.object);
        if (field) image.asset = field;
        delete image.object;
      }
      page.proxy.cleanup();
    }
    const metadata = await pdf.getMetadata().catch(() => null);
    const manifest: PdfImportManifest = {
      version: 1,
      fileName: file.name,
      title: documentTitle(metadata?.info as Record<string, unknown> | undefined, file.name),
      pageCount: pages.length,
      pages: pages.map((page) => page.analysis),
      summary: summarize(pages.map((page) => page.analysis)),
      renderScale: RENDER_SCALE,
    };
    form.append("manifest", new Blob([JSON.stringify(manifest)], { type: "application/json" }), "manifest.json");
    onProgress({ stage: "saving" });
    return { form, manifest };
  } finally {
    close();
  }
}

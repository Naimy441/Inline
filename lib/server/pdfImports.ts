import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Node as PMNode } from "prosemirror-model";
import { ensureBlockIds } from "@/lib/doc/ids";
import { schema } from "@/lib/doc/schema";
import { DEFAULT_SETTINGS, FONT_FAMILIES, PAPER_SIZES, googleFontValue, normalizeSettings, type DocumentSettings, type PaperSize } from "@/lib/doc/settings";
import { fontStyle, variableWeight, TEX_MATH_FONT } from "@/lib/pdf/import/text";
import type { PdfBox, PdfImportManifest, PdfPageAnalysis } from "@/lib/pdf/import/types";
import { lineMetrics } from "@/lib/doc/fontMetrics";
import { listFonts, saveFont } from "@/lib/server/fonts";
import { findGoogleFont, keepGoogleFont } from "@/lib/server/googleFonts";
import { documentHub, type LiveDocument } from "@/lib/server/hub";
import { log } from "@/lib/server/log";
import { cropBitmap, decodePng, encodePng, shrinkBitmap, type Bitmap } from "@/lib/server/png";
import { findUpload, readPdfImportFile, saveUpload, writePdfImportFile } from "@/lib/server/store";

/**
 * PDF imports on the server. The browser reads the PDF and draws its pages
 * (lib/pdf/import/prepare.ts); this keeps what it sends: the original file,
 * each page drawn without its annotations (at 3× for figures, at 2× for
 * Claude to read), its annotations alone (for the overlay), the pictures in
 * it, and what the pages hold (the manifest).
 *
 * The new document starts as the original pages: a picture of each page's
 * text area, one page each, separated by page breaks. Claude then rebuilds
 * page by page as editable text (lib/agent/pdfTools.ts), replacing what is
 * between the page breaks, so the document keeps one page per original page
 * and the annotations, drawn per page, sit where they were.
 */

export type PdfImportRecord = {
  version: 1;
  documentId: string;
  createdAt: number;
  fileName: string;
  /** The original PDF, as an upload. */
  source: string;
  manifest: PdfImportManifest;
  /** Per page (index 0 is page 1): the page without annotations at 3× and 2×, its annotations alone, and the placeholder picture. */
  pages: Array<{
    clean: string;
    view: string;
    ink: string | null;
    placeholder: string | null;
    /** The page's drawings, cut out as pictures for its draft (lib/server/pdfDrafts.ts). */
    crops?: Array<{ box: PdfBox; url: string }>;
    /** Equations the draft couldn't read back, cut out as pictures. */
    equations?: Array<{ box: PdfBox; url: string }>;
  }>;
  /** When Claude said the conversion was finished. */
  finishedAt?: number;
  /** The fonts the PDF carried, kept as document fonts: by the PDF's name for each, its family and style. */
  fonts?: Record<string, PdfFontFace>;
  /** Each font's file (an upload), by the PDF's name for it, for the widths of its letters. */
  fontFiles?: Record<string, string>;
};

/** A face of a document font: its family, and whether it's the bold or italic one. */
export type PdfFontFace = { family: string; bold: boolean; italic: boolean };

export class PdfImportError extends Error {}

/** The marker on a page's placeholder picture: its image title. */
export const PLACEHOLDER_TITLE = (page: number) => `pdf-page:${page}`;

export function isPlaceholder(node: PMNode) {
  return node.type.name === "image" && /^pdf-page:\d+$/.test(String(node.attrs.title ?? ""));
}

export async function readPdfImport(documentId: string) {
  const record = await readPdfImportFile<PdfImportRecord>(documentId).catch(() => null);
  return record?.version === 1 ? record : null;
}

export async function writePdfImport(record: PdfImportRecord) {
  await writePdfImportFile(record.documentId, record);
}

/** The PDF import a document (or the document a tab belongs to) came from. */
export async function pdfImportFor(doc: LiveDocument) {
  return (await readPdfImport(doc.id)) ?? (doc.meta.parentId ? await readPdfImport(doc.meta.parentId) : null);
}

// --- page setup and fonts ------------------------------------------------------------------

/** The paper size of a page in points: a known one (portrait or landscape), or the exact size. */
export function paperFor(width: number, height: number): Pick<DocumentSettings["pageSetup"], "paperSize" | "orientation" | "customSize"> {
  const orientation = width > height ? "landscape" : "portrait";
  const short = Math.min(width, height) / 72;
  const long = Math.max(width, height) / 72;
  const known = (Object.entries(PAPER_SIZES) as Array<[PaperSize, { width: number; height: number }]>).find(([, paper]) => Math.abs(paper.width - short) < 0.06 && Math.abs(paper.height - long) < 0.06);
  if (known) return { paperSize: known[0], orientation };
  const nearest = (Object.entries(PAPER_SIZES) as Array<[PaperSize, { width: number; height: number }]>).sort((a, b) => Math.hypot(a[1].width - short, a[1].height - long) - Math.hypot(b[1].width - short, b[1].height - long))[0]![0];
  return { paperSize: nearest, orientation, customSize: { width: Math.round(short * 1000) / 1000, height: Math.round(long * 1000) / 1000 } };
}

/** The family TeX's fonts are shown in: KaTeX's Computer Modern faces, kept as a document font. */
export const COMPUTER_MODERN = "Computer Modern";

const TEX_FONT = /^(cm[a-z]*\d*|lm[a-z]*\d*|lmroman|sf[a-z]{2}\d+|ec[a-z]{2}\d+|tc[a-z]{2}\d+|cmu|latinmodern|computermodern)/i;

type FontChoice = { family: string; css: string; google?: string; computerModern?: boolean };

/** A CSS font for a PDF's font: the same family, a close one Inline has, or one from Google Fonts. */
export async function fontFor(pdfFont: string, options: { lookupGoogle?: boolean } = {}): Promise<FontChoice> {
  const name = pdfFont.replace(/^[A-Z]{6}\+/, "");
  const known = (label: string): FontChoice => ({ family: label, css: FONT_FAMILIES.find((font) => font.label === label)!.value });
  if (TEX_FONT.test(name)) return { family: COMPUTER_MODERN, css: `"${COMPUTER_MODERN}", "Latin Modern Roman", "CMU Serif", Georgia, serif`, computerModern: true };
  if (/times|tinos|nimbusrom|nimbus ?roman|liberationserif|texgyretermes|termes|stix|ptmr|utm/i.test(name)) return known("Times New Roman");
  if (/helvetica|arial|nimbussan|nimbus ?sans|liberationsans|arimo|texgyreheros|phvr|uhv/i.test(name)) return known("Arial");
  if (/courier|nimbusmon|nimbus ?mono|liberationmono|cousine|pcrr|menlo|monaco|consola|sfmono|mono\b|monospace|inconsolata|andale|lucidaconsole/i.test(name)) return known("Courier New");
  if (/georgia/i.test(name)) return known("Georgia");
  if (/garamond/i.test(name)) return known("EB Garamond");
  if (/merriweather/i.test(name)) return known("Merriweather");
  if (/^inter\b/i.test(name)) return known("Inter");
  const aliases: Array<[RegExp, string]> = [
    [/calibri/i, "Carlito"],
    [/cambria/i, "Caladea"],
    [/palatino|pagella|palladio|pplr/i, "Gelasio"],
    [/bookman|bonum/i, "Libre Baskerville"],
    [/century|schoolbook|schola|pncr/i, "Gelasio"],
    [/segoe|verdana|tahoma/i, "Open Sans"],
  ];
  const alias = aliases.find(([pattern]) => pattern.test(name))?.[1];
  // "OpenSans-Bold" → "Open Sans", "SourceSerifPro-Regular" → "Source Serif Pro".
  const family = alias ?? name.replace(/[-,].*$/, "").replace(/(MT|PS|Std|Pro)$/g, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  if (options.lookupGoogle !== false && family) {
    const google = await findGoogleFont(family).catch(() => null);
    if (google) return { family: google.family, css: googleFontValue(google), google: google.family };
  }
  return /serif|roman|book|text|times|minion|garamond/i.test(name) && !/sans/i.test(name) ? known("Georgia") : known("Arial");
}

export const COMPUTER_MODERN_TYPEWRITER = "Computer Modern Typewriter";
export const COMPUTER_MODERN_SANS = "Computer Modern Sans";

const KATEX_FACES: Array<{ family: string; file: string; bold: boolean; italic: boolean }> = [
  { family: COMPUTER_MODERN, file: "KaTeX_Main-Regular.ttf", bold: false, italic: false },
  { family: COMPUTER_MODERN, file: "KaTeX_Main-Bold.ttf", bold: true, italic: false },
  { family: COMPUTER_MODERN, file: "KaTeX_Main-Italic.ttf", bold: false, italic: true },
  { family: COMPUTER_MODERN, file: "KaTeX_Main-BoldItalic.ttf", bold: true, italic: true },
  { family: COMPUTER_MODERN_TYPEWRITER, file: "KaTeX_Typewriter-Regular.ttf", bold: false, italic: false },
  { family: COMPUTER_MODERN_SANS, file: "KaTeX_SansSerif-Regular.ttf", bold: false, italic: false },
  { family: COMPUTER_MODERN_SANS, file: "KaTeX_SansSerif-Bold.ttf", bold: true, italic: false },
  { family: COMPUTER_MODERN_SANS, file: "KaTeX_SansSerif-Italic.ttf", bold: false, italic: true },
];

/**
 * Keep KaTeX's Computer Modern faces (roman, typewriter, sans) as document
 * fonts (once), so TeX documents look like TeX.
 */
export async function ensureComputerModern() {
  const folder = path.join(/* turbopackIgnore: true */ process.cwd(), "node_modules", "katex", "dist", "fonts");
  for (const face of KATEX_FACES) {
    const data = await readFile(path.join(folder, face.file)).catch(() => null);
    if (data) await saveFont({ family: face.family, bold: face.bold, italic: face.italic, data: new Uint8Array(data) });
  }
}

export { TEX_MATH_FONT };

/** The Inline font to set a PDF font's text in, or "math" for TeX's math fonts (no lookup online). */
export function inlineFontName(pdfFont: string): string {
  const name = pdfFont.replace(/^[A-Z]{6}\+/, "");
  if (TEX_MATH_FONT.test(name)) return "math";
  if (/^(cmtt|sftt|lmmono|cmvtt|tctt|ectt)/i.test(name)) return COMPUTER_MODERN_TYPEWRITER;
  if (/^(cmss|sfss|lmsans|ecss|tcss)/i.test(name)) return COMPUTER_MODERN_SANS;
  if (TEX_FONT.test(name)) return COMPUTER_MODERN;
  return "";
}

// --- the PDF's own fonts --------------------------------------------------------------------

/** TeX's text fonts by series: the family a face belongs to (with its size), and its style. */
const TEX_SERIES: Record<string, { family: string; bold?: boolean; italic?: boolean }> = {
  r: { family: "R" },
  bx: { family: "R", bold: true },
  ti: { family: "R", italic: true },
  bxti: { family: "R", bold: true, italic: true },
  bi: { family: "R", bold: true, italic: true },
  tt: { family: "TT" },
  itt: { family: "TT", italic: true },
  tti: { family: "TT", italic: true },
  ss: { family: "SS" },
  ssbx: { family: "SS", bold: true },
  sx: { family: "SS", bold: true },
  ssi: { family: "SS", italic: true },
  si: { family: "SS", italic: true },
};

/**
 * The family a PDF font is a face of, and which face: TeX's CMBX12 is the bold
 * of CMR12, CMTI10 the italic of CMR10, SFBX1200 the bold of SFRM1200;
 * "TimesNewRomanPS-BoldMT" the bold of TimesNewRomanPS.
 */
export function pdfFontFace(name: string): { base: string; bold: boolean; italic: boolean } {
  const clean = name.replace(/^[A-Z]{6}\+/, "");
  const tex = /^(cm|ec|tc|sf)([a-z]+?)(\d+)$/i.exec(clean);
  if (tex) {
    const prefix = tex[1]!.toUpperCase();
    let series = tex[2]!.toLowerCase();
    // cm-super's and the EC fonts' roman is "rm"; CM's is "r".
    if (prefix !== "CM" && series === "rm") series = "r";
    const known = TEX_SERIES[series];
    if (known) return { base: `${prefix}${known.family === "R" && prefix !== "CM" ? "RM" : known.family}${tex[3]}`, bold: Boolean(known.bold), italic: Boolean(known.italic) };
    return { base: clean.toUpperCase(), bold: false, italic: false };
  }
  const style = fontStyle(clean);
  const base = clean.replace(/[-,].*$/, "").replace(/(MT|PS)$/g, "") || clean;
  // An instance of a variable font between regular and bold (a medium heading) is a family of its own, not the regular's.
  const weight = variableWeight(clean);
  const named = weight === null || weight === 400 || weight === 700 ? base : weight < 400 ? `${base} Light` : weight < 600 ? `${base} Medium` : weight < 700 ? `${base} Semibold` : `${base} Black`;
  return { base: named, bold: style.bold, italic: style.italic };
}

/** The family letters missing from a PDF font are shown in: Computer Modern's for TeX's, else the nearest Inline has. */
async function fallbackFor(name: string) {
  const inline = inlineFontName(name);
  if (inline && inline !== "math") return inline;
  return (await fontFor(name, { lookupGoogle: false })).family;
}

/**
 * Keep the fonts the PDF carried as document fonts, each face in its family
 * (named after the PDF: "CMR12 (week8-2)"), with only the letters the PDF
 * used; letters it didn't use come from a stand-in (fallbackFor). Returns,
 * by the PDF's font name, the family and style to set its text in.
 */
export async function keepPdfFonts(manifest: PdfImportManifest, files: ImportFiles): Promise<{ faces: Record<string, PdfFontFace>; files: Record<string, string> }> {
  // Every font's file is kept with the import, math fonts' too, for the widths of its letters when drafting pages.
  const fontFiles: Record<string, string> = {};
  for (const font of manifest.fonts ?? []) {
    const data = files.get(font.field);
    if (data && data.length >= 64) fontFiles[font.name] = await newUpload("otf", data);
  }
  const fonts = (manifest.fonts ?? []).filter((font) => !TEX_MATH_FONT.test(font.name));
  if (!fonts.length) return { faces: {}, files: fontFiles };
  const stem = manifest.fileName.replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9 _.-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 24) || "PDF";
  const faces = fonts
    .map((font) => ({ font, data: files.get(font.field), face: pdfFontFace(font.name) }))
    .filter((entry): entry is typeof entry & { data: Uint8Array } => Boolean(entry.data && entry.data.length >= 64));
  const families = new Map<string, typeof faces>();
  for (const entry of faces) {
    const group = families.get(entry.face.base) ?? [];
    // One face per style: the first the PDF uses.
    if (!group.some((other) => other.face.bold === entry.face.bold && other.face.italic === entry.face.italic)) group.push(entry);
    families.set(entry.face.base, group);
  }
  const stored = await listFonts();
  const result: Record<string, PdfFontFace> = {};
  for (const [base, group] of families) {
    // A family of this name kept from another PDF (other letters) gets a number.
    const ids = new Set(group.map((entry) => createHash("sha256").update(entry.data).digest("hex").slice(0, 24)));
    let family = `${base} (${stem})`;
    for (let n = 2; stored.some((font) => font.family.toLowerCase() === family.toLowerCase() && !ids.has(font.id)) && n < 100; n += 1) family = `${base} (${stem} ${n})`;
    for (const entry of group) {
      const saved = await saveFont({ family, bold: entry.face.bold, italic: entry.face.italic, data: entry.data, partial: true, fallback: await fallbackFor(entry.font.name) }).catch((error) => {
        log("warn", "a PDF's font couldn't be kept", { font: entry.font.name, error });
        return null;
      });
      if (saved) result[entry.font.name] = { family: saved.family, bold: entry.face.bold, italic: entry.face.italic };
    }
  }
  // Faces of the same style as one kept (another size's) are set in the kept one.
  for (const entry of faces) {
    if (result[entry.font.name]) continue;
    const kept = Object.values(result).find((face) => face.family.startsWith(`${entry.face.base} (`));
    if (kept) result[entry.font.name] = { family: kept.family, bold: entry.face.bold, italic: entry.face.italic };
  }
  return { faces: result, files: fontFiles };
}

/** A CSS font family list for a kept PDF family, with its stand-in after it. */
export function pdfFamilyCss(face: PdfFontFace, fallback: string) {
  return `"${face.family}", ${fallback}`;
}

/** The document's settings, from what the pages share. */
export async function settingsFor(manifest: PdfImportManifest, pdfFonts: Record<string, PdfFontFace> = {}): Promise<{ settings: DocumentSettings; font: FontChoice }> {
  const first = manifest.pages[0];
  const summary = manifest.summary;
  const standIn = await fontFor(summary.bodyFont || "Helvetica");
  // The body text in the PDF's own font when it carries it, else the nearest Inline has.
  const own = pdfFonts[summary.bodyFont];
  const font: FontChoice = own ? { ...standIn, family: own.family, css: pdfFamilyCss(own, standIn.css) } : standIn;
  // A little more room at the bottom than the PDF's text used, so a page that runs a point longer in the editor still fits.
  const pageSetup = { ...paperFor(first?.width ?? 612, first?.height ?? 792), margins: { ...summary.margins, bottom: Math.max(0.2, Math.round((summary.margins.bottom - 0.15) * 100) / 100) } };
  const header = summary.header;
  const footer = summary.footer;
  const numbers = summary.pageNumbers;
  // A number at the end of the running header is the page number: it's drawn by the number setting, not the header text.
  const headerParts = header ? [...header.parts] : [];
  const footerParts = footer ? [...footer.parts] : [];
  const stripNumber = (parts: string[]) => (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1]!) ? parts.slice(0, -1) : parts);
  const headerText = stripNumber(headerParts);
  const footerText = stripNumber(footerParts);
  const pageHeight = first?.height ?? 792;
  const headerSize = Math.round((header?.size ?? footer?.size ?? HEADER_PT) * 10) / 10;
  const settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    pageSetup,
    fontFamily: font.css,
    fontSize: Math.round(summary.bodySize * 2) / 2 || 11,
    lineSpacing: Math.max(0.8, Math.min(3, summary.lineSpacing || 1.2)),
    paragraphSpacing: Math.max(0, Math.min(36, summary.paragraphSpacing)),
    // A PDF sets its equations at the size of their text.
    mathSize: 1,
    headerFooter: {
      ...DEFAULT_SETTINGS.headerFooter,
      header: headerText.length === 2 ? `${headerText[0]}\t\t${headerText[1]}` : headerText.join("\t"),
      headerAlign: headerText.length === 1 && header ? header.align : "left",
      footer: footerText.length === 2 ? `${footerText[0]}\t\t${footerText[1]}` : footerText.join("\t"),
      footerAlign: footerText.length === 1 && footer ? footer.align : "center",
      // The first page has no header when the running header starts on page 2 (a title page).
      differentFirstPage: Boolean(header && !header.pages.includes(1) && manifest.pageCount > 1),
      ...(summary.headerRule ? { headerRule: true } : {}),
      // The header and footer where the PDF has them, in its size and in black, as the PDF prints them.
      size: headerSize,
      color: "#000000",
      // Parts of the header in sizes of their own (the page number, dropped above, had the last).
      ...(header?.partSizes && header.partSizes.length >= headerText.length ? { headerPartSizes: header.partSizes.slice(0, headerText.length) } : {}),
      ...(header ? { headerFrom: inches(header.y - lineMetrics(font.css).ascent * headerSize) } : {}),
      ...(() => {
        const baseline = footer?.y ?? (numbers?.position === "footer" ? numbers.y : undefined);
        return baseline !== undefined ? { footerFrom: inches(pageHeight - baseline - lineMetrics(font.css).descent * headerSize) } : {};
      })(),
    },
    pageNumbers: numbers ? { enabled: true, position: numbers.position, align: numbers.align, skipFirst: false } : DEFAULT_SETTINGS.pageNumbers,
  });
  return { settings, font };
}

/** The size the editor sets headers and footers in by default (app/styles/workspace.css). */
const HEADER_PT = 10;

/** Points as inches, kept within what the settings allow. */
function inches(pt: number) {
  return Math.round(Math.max(0, Math.min(3, pt / 72)) * 1000) / 1000;
}

// --- placeholders ------------------------------------------------------------------------

/** The page's text area as a picture, sized to fill the page's text area in the document. */
export function placeholderCrop(bitmap: Bitmap, page: PdfPageAnalysis, settings: DocumentSettings, scale: number) {
  const { margins } = settings.pageSetup;
  const x = margins.left * 72 * scale;
  const y = margins.top * 72 * scale;
  const width = page.width * scale - x - margins.right * 72 * scale;
  // A little short of the text area, so the picture and the space after it stay on one page.
  const height = page.height * scale - y - margins.bottom * 72 * scale - (settings.paragraphSpacing + 3) * scale;
  return cropBitmap(bitmap, x, y, width, height);
}

/** The starting document: each page's placeholder picture, with a page break between pages. */
export function placeholderDoc(record: PdfImportRecord) {
  const blocks: PMNode[] = [];
  record.pages.forEach((page, index) => {
    if (index > 0) blocks.push(schema.node("page_break"));
    const number = index + 1;
    blocks.push(
      page.placeholder
        ? schema.node("image", { src: page.placeholder, alt: `Page ${number} of “${record.fileName}”, being converted`, title: PLACEHOLDER_TITLE(number), width: "100%", align: "center" })
        : schema.node("paragraph"),
    );
  });
  return ensureBlockIds(schema.node("doc", null, blocks));
}

// --- pages in the document -----------------------------------------------------------------

export type PageRange = { page: number; from: number; to: number; nodes: PMNode[] };

/**
 * Where each original page is in the document: the blocks between page
 * breaks, the first page before the first break. A document with more
 * breaks than pages has its extra pages on the end.
 */
export function pageRanges(doc: PMNode): PageRange[] {
  const ranges: PageRange[] = [];
  let current: PageRange = { page: 1, from: 0, to: 0, nodes: [] };
  doc.forEach((node, offset) => {
    if (node.type.name === "page_break") {
      current.to = offset;
      ranges.push(current);
      current = { page: current.page + 1, from: offset + node.nodeSize, to: offset + node.nodeSize, nodes: [] };
      return;
    }
    current.nodes.push(node);
    current.to = offset + node.nodeSize;
  });
  ranges.push(current);
  return ranges;
}

/** Original pages still showing their placeholder picture. */
export function pagesLeft(doc: PMNode, pageCount: number) {
  const left: number[] = [];
  for (const range of pageRanges(doc)) {
    if (range.page > pageCount) break;
    if (range.nodes.some(isPlaceholder)) left.push(range.page);
  }
  return left;
}

/**
 * After a turn of the converting chat: "done" once no page is a picture any
 * more, else back to "pending" (Claude stopped, ran out of steps or failed),
 * so the editor offers to carry on.
 */
export async function settlePdfConversion(documentId: string, chatId: string) {
  const doc = await documentHub().get(documentId);
  const meta = doc?.meta.pdfImport;
  if (!doc || !meta || meta.chatId !== chatId || meta.status !== "converting") return;
  doc.setPdfImport({ status: pagesLeft(doc.doc, meta.pages).length ? "pending" : "done" });
}

// --- pictures ---------------------------------------------------------------------------

export async function readUpload(url: string) {
  const id = /\/api\/uploads\/([A-Za-z0-9_-]+)\./.exec(url)?.[1];
  if (!id) return null;
  const upload = await findUpload(id);
  return upload ? new Uint8Array(await readFile(upload.file)) : null;
}

const pageCache = new Map<string, Bitmap>();

/** A page's picture without annotations, at 3× (decoded once, a few kept in memory). */
export async function pageBitmap(record: PdfImportRecord, page: number) {
  const url = record.pages[page - 1]?.clean;
  if (!url) throw new PdfImportError(`The PDF has no page ${page}.`);
  const cached = pageCache.get(url);
  if (cached) return cached;
  const data = await readUpload(url);
  if (!data) throw new PdfImportError(`The picture of page ${page} is missing.`);
  const bitmap = decodePng(data);
  pageCache.set(url, bitmap);
  while (pageCache.size > 4) pageCache.delete(pageCache.keys().next().value!);
  return bitmap;
}

export async function newUpload(extension: string, data: Uint8Array) {
  const id = randomUUID().replace(/-/g, "");
  await saveUpload(id, extension, data);
  return `/api/uploads/${id}.${extension}`;
}

/**
 * Cut a region of a page (in points) out as a picture: a figure drawn with
 * lines and curves, or anything else best kept as it looks. Returns its URL
 * and size in points.
 */
export async function cropRegion(record: PdfImportRecord, page: number, box: PdfBox, options: { maxPixels?: number } = {}) {
  const bitmap = await pageBitmap(record, page);
  const scale = record.manifest.renderScale;
  let crop = cropBitmap(bitmap, box.x * scale, box.y * scale, box.width * scale, box.height * scale);
  const max = options.maxPixels ?? 4_000_000;
  if (crop.width * crop.height > max) {
    const factor = Math.sqrt(max / (crop.width * crop.height));
    crop = shrinkBitmap(crop, crop.width * factor, crop.height * factor);
  }
  const url = await newUpload("png", encodePng(crop));
  return { url, width: Math.round((crop.width / scale) * 100) / 100, height: Math.round((crop.height / scale) * 100) / 100 };
}

// --- creating the document ----------------------------------------------------------------

export type StoredImport = { doc: LiveDocument; record: PdfImportRecord };

/** Pictures of a page sent with an import, by form field. */
export type ImportFiles = { get(name: string): Uint8Array | null };

/** Keep an import's files and create its document. */
export async function createPdfImport(input: { manifest: PdfImportManifest; source: Uint8Array; files: ImportFiles; folderId: string | null }): Promise<StoredImport> {
  const { manifest } = input;
  const { faces: pdfFonts, files: fontFiles } = await keepPdfFonts(manifest, input.files);
  const { settings, font } = await settingsFor(manifest, pdfFonts);
  if (font.computerModern || manifest.summary.fonts.some((item) => inlineFontName(item.name) && inlineFontName(item.name) !== "math")) await ensureComputerModern().catch((error) => log("warn", "the Computer Modern faces couldn't be kept", { error }));
  if (font.google) void keepGoogleFont(font.google).catch(() => undefined);
  const source = await newUpload("pdf", input.source);
  const pages: PdfImportRecord["pages"] = [];
  for (const page of manifest.pages) {
    const clean = input.files.get(`clean-${page.page}`);
    const view = input.files.get(`view-${page.page}`);
    if (!clean || !view) throw new PdfImportError(`The picture of page ${page.page} is missing.`);
    const ink = input.files.get(`ink-${page.page}`);
    let placeholder: string | null = null;
    try {
      placeholder = await newUpload("png", encodePng(placeholderCrop(decodePng(clean), page, settings, manifest.renderScale)));
    } catch (error) {
      log("warn", "a PDF page's placeholder couldn't be made", { page: page.page, error });
    }
    pages.push({ clean: await newUpload("png", clean), view: await newUpload("png", view), ink: ink ? await newUpload("png", ink) : null, placeholder });
    // A picture placed twice is sent once and kept once.
    const kept = new Map<string, string>();
    for (const image of page.images) {
      const field = image.asset;
      delete image.asset;
      delete image.object;
      if (!field) continue;
      let url = kept.get(field);
      const data = url ? null : input.files.get(field);
      if (data) {
        url = await newUpload(data[0] === 0xff && data[1] === 0xd8 ? "jpg" : "png", data);
        kept.set(field, url);
      }
      if (url) image.url = url;
    }
  }
  const title = manifest.title ?? (manifest.fileName.replace(/\.pdf$/i, "").trim() || "Imported PDF");
  const record: PdfImportRecord = { version: 1, documentId: "", createdAt: Date.now(), fileName: manifest.fileName, source, manifest, pages, ...(Object.keys(pdfFonts).length ? { fonts: pdfFonts } : {}), ...(Object.keys(fontFiles).length ? { fontFiles } : {}) };
  const doc = await documentHub().create({ title, doc: placeholderDoc(record).toJSON(), settings, folderId: input.folderId });
  record.documentId = doc.id;
  await writePdfImport(record);
  doc.setPdfImport({
    pages: manifest.pageCount,
    inkPages: manifest.pages.filter((page) => page.ink.count > 0).map((page) => page.page),
    showAnnotations: false,
    status: "pending",
    converted: [],
  });
  return { doc, record };
}

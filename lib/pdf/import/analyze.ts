import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  classifyOperators,
  findGraphics,
  findRules,
  inkBox,
  overlapArea,
  repeatedInk,
  restoreContent,
  type AnnotationInfo,
  type Classification,
  type OperatorList,
  type Ops,
} from "@/lib/pdf/import/classify";
import { fontStyle, median, round, textLines, type FontInfo, type TextItem } from "@/lib/pdf/import/text";
import type { PdfBox, PdfDocumentSummary, PdfHeaderFooter, PdfImagePlacement, PdfLink, PdfPageAnalysis, PdfTextLine } from "@/lib/pdf/import/types";

/**
 * Reads a PDF the way Inline imports it: per page, its text lines, pictures,
 * links, rules and frames, drawings, and which drawing operations are
 * annotations (lib/pdf/import/classify.ts); then what holds across the pages
 * (margins, main font, header and footer). Runs on pdf.js in the browser (and
 * in Node for tests); the operator codes are passed in.
 */

/** pdf.js's annotation mode that draws annotations' appearances onto the page (AnnotationMode.ENABLE). */
export const ANNOTATIONS_ON_CANVAS = 1;

export type AnalyzedPage = { analysis: PdfPageAnalysis; classification: Classification; /** The page's fonts, by pdf.js id (in its commonObjs). */ fontIds?: string[] };

type Annotation = AnnotationInfo & { url?: string; unsafeUrl?: string; dest?: unknown; contentsObj?: { str?: string }; titleObj?: { str?: string } };

/**
 * Analyze a page. To draw it with or without its annotations, the operators
 * must be classified as the drawing sees them: pdf.js merges some operators
 * when it draws (its queue optimizer) but not in getOperatorList(), so the
 * browser passes the list a drawing used (see captureOperatorList).
 */
export async function analyzePage(pdf: PDFDocumentProxy, page: PDFPageProxy, OPS: Ops, options: { operatorList?: OperatorList } = {}): Promise<AnalyzedPage> {
  const viewport = page.getViewport({ scale: 1 });
  const transform = viewport.transform as number[];
  const width = round(viewport.width);
  const height = round(viewport.height);
  const [list, annotations, content] = await Promise.all([
    options.operatorList ?? page.getOperatorList({ annotationMode: ANNOTATIONS_ON_CANVAS }),
    page.getAnnotations({ intent: "display" }).catch(() => [] as unknown[]) as Promise<Annotation[]>,
    page.getTextContent(),
  ]);
  const fonts = new Map<string, FontInfo>();
  const fontOf = (id: string): FontInfo => {
    const known = fonts.get(id);
    if (known) return known;
    let info: FontInfo = fontStyle(String((content.styles as Record<string, { fontFamily?: string }>)[id]?.fontFamily ?? id));
    try {
      if (page.commonObjs.has(id)) {
        const font = page.commonObjs.get(id) as { name?: string; bold?: boolean; italic?: boolean; black?: boolean };
        if (font?.name) info = fontStyle(font.name, { bold: font.bold || font.black, italic: font.italic });
      }
    } catch {
      // The style name is all there is.
    }
    fonts.set(id, info);
    return info;
  };
  const lines = textLines(content.items.filter((item) => "str" in item) as unknown as TextItem[], transform, fontOf);
  const classification = classifyOperators(list, OPS, {
    viewport: transform,
    pageWidth: width,
    pageHeight: height,
    annotations: annotations.map((item) => ({ id: String(item.id), subtype: String(item.subtype) })),
    textBoxes: lines.map((line) => line.box),
  });

  const pageNumber = page.pageNumber;
  const images: PdfImagePlacement[] = [];
  for (const record of classification.paints) {
    if (record.kind !== "image" || record.ink || !record.box || record.annotation) continue;
    // Bullets and specks drawn as pictures aren't figures.
    if (record.box.width < 10 || record.box.height < 10) continue;
    const box = clampBox(record.box, width, height);
    if (!box) continue;
    images.push({
      id: `p${pageNumber}-i${images.length + 1}`,
      box,
      pixelWidth: record.pixelWidth ?? 0,
      pixelHeight: record.pixelHeight ?? 0,
      ...(record.object ? { object: record.object } : {}),
    });
  }

  const toPage = (rect: number[] | undefined): PdfBox | null => {
    if (!rect || rect.length < 4) return null;
    const [x0, y0] = viewport.convertToViewportPoint(rect[0]!, rect[1]!) as [number, number];
    const [x1, y1] = viewport.convertToViewportPoint(rect[2]!, rect[3]!) as [number, number];
    return { x: round(Math.min(x0, x1)), y: round(Math.min(y0, y1)), width: round(Math.abs(x1 - x0)), height: round(Math.abs(y1 - y0)) };
  };
  const links: PdfLink[] = [];
  for (const annotation of annotations) {
    if (annotation.subtype !== "Link") continue;
    const box = toPage(annotation.rect);
    if (!box) continue;
    const link: PdfLink = { box };
    const url = annotation.url ?? annotation.unsafeUrl;
    if (url) link.url = url;
    else if (annotation.dest) {
      const target = await destinationPage(pdf, annotation.dest).catch(() => null);
      if (target) link.page = target;
    }
    if (!link.url && !link.page) continue;
    const text = lines
      .filter((line) => overlapArea(line.box, box) > 0)
      .flatMap((line) => line.runs.filter((run) => run.x + run.width > box.x && run.x < box.x + box.width).map((run) => run.text))
      .join(" ")
      .trim();
    if (text) link.text = text.slice(0, 200);
    links.push(link);
  }

  const rules = findRules(classification, width, height).map((rule) => ({ ...rule, box: roundBox(rule.box), width: round(rule.width) }));
  const graphics = findGraphics(classification, rules, width, height)
    .map((box) => clampBox(box, width, height))
    .filter((box): box is PdfBox => Boolean(box));
  const notes = annotations
    .filter((item) => item.subtype !== "Link" && item.subtype !== "Widget" && item.subtype !== "Popup" && (item.contentsObj?.str ?? "").trim())
    .map((item) => ({ text: String(item.contentsObj!.str).trim().slice(0, 2000), box: toPage(item.rect) ?? { x: 0, y: 0, width: 0, height: 0 }, kind: String(item.subtype) }));
  const analysis: PdfPageAnalysis = {
    page: pageNumber,
    width,
    height,
    lines,
    images,
    links,
    rules,
    graphics,
    ink: inkSummary(classification, notes),
    scanned: !lines.length && classification.paints.some((record) => record.kind === "image" && record.box && record.box.width * record.box.height > 0.5 * width * height),
  };
  return { analysis, classification, fontIds: [...fonts.keys()] };
}

function inkSummary(classification: Classification, notes: PdfPageAnalysis["ink"]["notes"]): PdfPageAnalysis["ink"] {
  const inked = classification.paints.filter((record) => record.ink);
  const box = inkBox(classification);
  return { count: inked.length, box: box ? roundBox(box) : null, kinds: [...new Set(inked.map((record) => record.inkKind ?? "pen"))], notes };
}

/**
 * The operator list pdf.js draws a page with, for `analyzePage`: a pass that
 * draws nothing and keeps the list. Drawing the page again with the same
 * annotation mode reuses this list, so its indices match the classification.
 */
export async function captureOperatorList(page: PDFPageProxy, canvas: unknown): Promise<OperatorList> {
  let captured: OperatorList | null = null;
  const viewport = page.getViewport({ scale: 0.05 });
  await page.render({
    canvas: canvas as HTMLCanvasElement,
    viewport,
    annotationMode: ANNOTATIONS_ON_CANVAS,
    operationsFilter: (_index: number, list: OperatorList) => {
      captured = list;
      return false;
    },
  } as never).promise;
  return captured ?? { fnArray: [], argsArray: [] };
}

/** Re-sum a page's ink after `restoreContent`. */
export function refreshInk(page: AnalyzedPage) {
  page.analysis.ink = inkSummary(page.classification, page.analysis.ink.notes);
}

/** Ink found in the same place on several pages is the document's (a logo); put it back. */
export function settleInk(pages: AnalyzedPage[]) {
  const repeated = repeatedInk(pages.map((page) => page.classification));
  if (!repeated.size) return;
  for (const page of pages) {
    restoreContent(page.classification, repeated);
    refreshInk(page);
  }
}

async function destinationPage(pdf: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : (dest as unknown[]);
  const ref = explicit?.[0];
  if (ref == null) return null;
  if (typeof ref === "number") return ref + 1;
  return (await pdf.getPageIndex(ref as { num: number; gen: number })) + 1;
}

function roundBox(box: PdfBox): PdfBox {
  return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) };
}

function clampBox(box: PdfBox, width: number, height: number): PdfBox | null {
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const right = Math.min(width, box.x + box.width);
  const bottom = Math.min(height, box.y + box.height);
  if (right - x < 1 || bottom - y < 1) return null;
  return roundBox({ x, y, width: right - x, height: bottom - y });
}

// --- the document as a whole ------------------------------------------------------------

/** Digits stand for any number, so "Page 3" on one page matches "Page 4" on the next. */
const pattern = (text: string) => text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();

type Repeated = { header: PdfHeaderFooter | null; footer: PdfHeaderFooter | null; lines: Set<PdfTextLine> };

/** Lines repeated near the top or bottom of most pages: the running header and footer. */
function runningLines(pages: PdfPageAnalysis[]): Repeated {
  const lines = new Set<PdfTextLine>();
  const pick = (zone: "top" | "bottom"): PdfHeaderFooter | null => {
    const found = new Map<string, Array<{ page: number; line: PdfTextLine }>>();
    for (const page of pages) {
      const band = page.height * 0.13;
      for (const line of page.lines) {
        const inZone = zone === "top" ? line.box.y < band : line.box.y + line.box.height > page.height - band;
        if (!inZone) continue;
        const key = `${pattern(line.text)}@${Math.round(line.baseline / 4)}`;
        const list = found.get(key) ?? [];
        list.push({ page: page.page, line });
        found.set(key, list);
      }
    }
    const needed = Math.max(2, Math.ceil(pages.length * 0.4));
    const candidates = [...found.values()].filter((list) => new Set(list.map((item) => item.page)).size >= needed && !/^#$/.test(pattern(list[0]!.line.text)));
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.length - a.length);
    const best = candidates[0]!;
    for (const list of candidates) for (const item of list) lines.add(item.line);
    const sample = best[best.length - 1]!.line;
    const parts = sample.text.split("\t").map((part) => part.trim()).filter(Boolean);
    const width = pages[0]?.width ?? 612;
    const center = sample.box.x + sample.box.width / 2;
    const align = Math.abs(center - width / 2) < width * 0.1 ? "center" : center < width / 2 ? "left" : "right";
    return { text: sample.text, parts, y: sample.baseline, size: sample.size, pages: [...new Set(best.map((item) => item.page))], align };
  };
  const header = pick("top");
  const footer = pick("bottom");
  return { header, footer, lines };
}

/** A line holding just the page's number ("3", "- 3 -", "Page 3", "3 of 7"). */
function pageNumberLine(page: PdfPageAnalysis, line: PdfTextLine) {
  const text = line.text.replace(/\s+/g, " ").trim();
  const match = text.match(/^(?:page\s+)?[-–—]?\s*(\d+)\s*[-–—]?(?:\s*(?:of|\/)\s*\d+)?$/i);
  return Boolean(match) && Math.abs(Number(match![1]) - page.page) <= 50;
}

export function summarize(pages: PdfPageAnalysis[]): PdfDocumentSummary {
  const running = pages.length > 1 ? runningLines(pages) : { header: null, footer: null, lines: new Set<PdfTextLine>() };
  const numbers: Array<{ position: "header" | "footer"; align: "left" | "center" | "right"; y?: number }> = [];
  const chrome = new Set<PdfTextLine>(running.lines);
  for (const page of pages) {
    const band = page.height * 0.13;
    for (const line of page.lines) {
      const top = line.box.y < band;
      const bottom = line.box.y + line.box.height > page.height - band;
      if (!(top || bottom) || !pageNumberLine(page, line)) continue;
      chrome.add(line);
      const center = line.box.x + line.box.width / 2;
      const align = Math.abs(center - page.width / 2) < page.width * 0.1 ? "center" : center < page.width / 2 ? "left" : "right";
      numbers.push({ position: top ? "header" : "footer", align, y: line.baseline });
    }
  }
  // A number inside the running header ("… · 3") is drawn as part of it.
  for (const zone of [running.header, running.footer]) {
    if (zone && /\d+\s*$/.test(zone.parts[zone.parts.length - 1] ?? "") && zone.parts.length > 1) {
      const last = zone.parts[zone.parts.length - 1]!;
      if (/^\d+$/.test(last.trim())) numbers.push({ position: zone === running.header ? "header" : "footer", align: "right" });
    }
  }
  const pageNumbers = numbers.length >= Math.max(1, Math.ceil(pages.length * 0.4)) ? mostCommon(numbers.map((item) => `${item.position}:${item.align}`)) : null;

  const body = pages.flatMap((page) => page.lines.filter((line) => !chrome.has(line)).map((line) => ({ page, line })));
  const fonts = new Map<string, { name: string; bold: boolean; italic: boolean; chars: number; sizes: Map<number, number> }>();
  for (const { line } of body) {
    for (const run of line.runs) {
      const key = `${run.font}|${run.bold}|${run.italic}`;
      const entry = fonts.get(key) ?? { name: run.font, bold: run.bold, italic: run.italic, chars: 0, sizes: new Map<number, number>() };
      const chars = run.text.replace(/\s/g, "").length;
      entry.chars += chars;
      const size = Math.round(run.size * 2) / 2;
      entry.sizes.set(size, (entry.sizes.get(size) ?? 0) + chars);
      fonts.set(key, entry);
    }
  }
  const fontList = [...fonts.values()]
    .sort((a, b) => b.chars - a.chars)
    .map((font) => ({ name: font.name, bold: font.bold, italic: font.italic, chars: font.chars, sizes: [...font.sizes].sort((a, b) => b[1] - a[1]).map(([size]) => size) }));
  const sizes = new Map<number, number>();
  for (const { line } of body) for (const run of line.runs) sizes.set(Math.round(run.size * 2) / 2, (sizes.get(Math.round(run.size * 2) / 2) ?? 0) + run.text.length);
  const bodySize = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 11;
  const bodyFont = fontList.find((font) => !font.bold && !font.italic && font.sizes[0] === bodySize)?.name ?? fontList[0]?.name ?? "";

  // Line spacing: baseline to baseline between lines of the main size that follow one another.
  const gaps: number[] = [];
  for (const page of pages) {
    const main = page.lines.filter((line) => !chrome.has(line) && Math.abs(line.size - bodySize) < 0.6);
    for (let i = 1; i < main.length; i += 1) {
      const gap = main[i]!.baseline - main[i - 1]!.baseline;
      if (gap > bodySize * 0.95 && gap < bodySize * 3) gaps.push(Math.round(gap * 4) / 4);
    }
  }
  const lineGap = mostCommon(gaps.filter((gap) => gap < bodySize * 1.8).map(String));
  const lineSpacing = lineGap ? round(Number(lineGap) / bodySize) : 1.2;
  const extra = gaps.filter((gap) => lineGap && gap > Number(lineGap) + 1.5 && gap < Number(lineGap) * 2.2).map((gap) => String(Math.round((gap - Number(lineGap)) * 2) / 2));
  const paragraphSpacing = extra.length >= gaps.length * 0.12 ? Number(mostCommon(extra) ?? 0) : 0;

  // Margins: where the main text starts and ends, on every page.
  const lefts = new Map<number, number>();
  for (const { line } of body) lefts.set(Math.round(line.box.x), (lefts.get(Math.round(line.box.x)) ?? 0) + 1);
  const common = [...lefts].filter(([, count]) => count >= 3).map(([x]) => x);
  let left = common.length ? Math.min(...common) : Math.min(...body.map(({ line }) => line.box.x), 72);
  const widths = body.map(({ line }) => line.box.x + line.box.width);
  const textRight = widths.length ? percentile(widths, 0.95) : pages[0]!.width - 72;
  // Text indented throughout (every paragraph a list item) leaves the margin to lines and rules that run the
  // full width, out to the right margin: a header line, a rule under it.
  const spans = [
    ...pages.flatMap((page) => page.lines.filter((line) => line.box.width > page.width * 0.5).map((line) => line.box)),
    ...pages.flatMap((page) => page.rules.filter((rule) => rule.kind === "hline" && rule.box.width > page.width * 0.5).map((rule) => rule.box)),
  ].filter((box) => Math.abs(box.x + box.width - textRight) < 2.5 && box.x < left - 1.5 && box.x > 18);
  if (spans.length) left = percentile(spans.map((box) => box.x), 0.5);
  const tops = pages.map((page) => Math.min(...[...page.lines.filter((line) => !chrome.has(line)).map((line) => line.box.y), ...page.images.map((image) => image.box.y)])).filter(Number.isFinite);
  const bottoms = pages.map((page) => Math.max(...[...page.lines.filter((line) => !chrome.has(line)).map((line) => line.box.y + line.box.height), ...page.images.map((image) => image.box.y + image.box.height)])).filter(Number.isFinite);
  const width = pages[0]?.width ?? 612;
  const height = pages[0]?.height ?? 792;
  const inch = (pt: number) => Math.round(Math.max(0.25, Math.min(2.5, pt / 72)) * 100) / 100;
  const margins = {
    top: inch(tops.length ? Math.min(...tops) : 72),
    // A short PDF's text may stop well above the page number: the text area ends a line or two above it.
    bottom: inch(Math.min(bottoms.length ? height - Math.max(...bottoms) : 72, ...numbers.filter((item) => item.position === "footer" && item.y !== undefined).map((item) => height - item.y! + 2.5 * bodySize))),
    left: inch(left),
    right: inch(width - textRight),
  };
  const headerRule = Boolean(
    running.header &&
      pages.filter((page) => page.rules.some((rule) => rule.kind === "hline" && rule.box.y > running.header!.y && rule.box.y < running.header!.y + running.header!.size * 1.5 && rule.box.width > page.width * 0.4)).length >= Math.max(2, pages.length * 0.4),
  );
  const [position, align] = pageNumbers ? (pageNumbers.split(":") as ["header" | "footer", "left" | "center" | "right"]) : [null, null];
  return {
    margins,
    bodyFont,
    bodySize,
    lineSpacing,
    paragraphSpacing,
    header: running.header,
    footer: running.footer,
    pageNumbers: position && align ? { position, align, ...(numberBaselines(numbers, position, align)) } : null,
    fonts: fontList.slice(0, 12),
    headerRule,
  };
}

/** Where the page numbers of the most common kind sit (their median baseline). */
function numberBaselines(numbers: Array<{ position: string; align: string; y?: number }>, position: string, align: string) {
  const ys = numbers.filter((item) => item.position === position && item.align === align && item.y !== undefined).map((item) => item.y!);
  return ys.length ? { y: round(median(ys)) } : {};
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

export { median };

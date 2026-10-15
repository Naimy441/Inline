import { compose } from "@/lib/pdf/import/classify";
import type { PdfTextLine, PdfTextRun } from "@/lib/pdf/import/types";

/**
 * The page's text as lines, from pdf.js's text content. pdf.js hands over
 * pieces of text as the PDF draws them (a word, a few letters, a whole line);
 * these are gathered into lines by where they sit, with runs of one style.
 * Superscripts and subscripts stay in their line; a fraction's top and
 * bottom are lines of their own, as on the page.
 */

export type TextItem = { str: string; transform: number[]; width: number; height: number; fontName: string; hasEOL?: boolean; dir?: string };

export type FontInfo = { name: string; bold: boolean; italic: boolean };

/** "AAAAAB+CMBX12" → "CMBX12". */
/** TeX's math fonts: their text is part of an equation, written as LaTeX. */
export const TEX_MATH_FONT = /^(cmmi|cmsy|cmex|msbm|msam|eufm|eurm|rsfs|cmbsy|lmmath|stixmath)/i;

export function cleanFontName(name: string) {
  return name.replace(/^[A-Z]{6}\+/, "").trim();
}

const BOLD = /bold|black|heavy|semibold|demi|^cmbx|^sfbx|^lmroman\d*-bold|^cmb\d|-bd\b|\bbd\b|^ec?bx|bx\d/i;
const ITALIC = /italic|oblique|^cmti|^cmmi|^sfti|^cmsl|^sfsl|-it\b|\bit\d|^lmroman\d*-italic/i;

export function fontStyle(name: string, flags: { bold?: boolean; italic?: boolean } = {}): FontInfo {
  const clean = cleanFontName(name);
  return { name: clean, bold: Boolean(flags.bold) || BOLD.test(clean), italic: Boolean(flags.italic) || ITALIC.test(clean) };
}

/**
 * Text as it reads. TeX's symbol fonts (CMSY) put the minus sign at code 0,
 * which comes through as a control character; other control characters
 * are glyphs with no known letter.
 */
function readable(text: string, font: string) {
  const symbols = /^(cmsy|lmmathsymbols|msam|cmex)/i.test(font);
  return text.replace(/\u0000/g, symbols ? "\u2212" : "").replace(/[\u0001-\u0008\u000b-\u001f]/g, "");
}

type Piece = { text: string; x: number; right: number; baseline: number; size: number; font: FontInfo };

/** Lines of text, top to bottom, from text items placed by `viewport` (pdf.js viewport.transform at scale 1). */
export function textLines(items: readonly TextItem[], viewport: readonly number[], fontOf: (fontName: string) => FontInfo): PdfTextLine[] {
  const pieces: Piece[] = [];
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const m = compose(viewport, item.transform);
    // Only text running left to right across the page is gathered into lines; other text keeps its own.
    const size = Math.hypot(m[2], m[3]) || Math.hypot(m[0], m[1]);
    if (!(size > 0.5)) continue;
    const horizontal = Math.abs(m[1]) < Math.abs(m[0]) * 0.05;
    const scale = Math.hypot(m[0], m[1]) / (Math.hypot(item.transform[0]!, item.transform[1]!) || 1);
    const width = horizontal ? item.width * scale : size * item.str.length * 0.5;
    const font = fontOf(item.fontName);
    pieces.push({ text: readable(item.str, font.name), x: m[4], right: m[4] + width, baseline: m[5], size: Math.round(size * 100) / 100, font });
  }
  // Tallest first, so a line forms around its main text and smaller pieces (scripts) join it.
  const order = [...pieces].sort((a, b) => b.size - a.size);
  type Group = { center: number; size: number; pieces: Piece[] };
  const groups: Group[] = [];
  for (const piece of order) {
    const center = piece.baseline - piece.size * 0.3;
    const group = groups.find((item) => {
      if (Math.abs(item.center - center) > Math.max(item.size, piece.size) * 0.42) return false;
      // Text side by side on the same line, not text overlapping text (a fraction drawn over another).
      return !item.pieces.some((other) => piece.x < other.right - 0.5 && piece.right > other.x + 0.5 && Math.abs(other.baseline - piece.baseline) > piece.size * 0.6);
    });
    if (group) group.pieces.push(piece);
    else groups.push({ center, size: piece.size, pieces: [piece] });
  }
  const lines = groups.map((group) => buildLine(group.pieces));
  return lines.sort((a, b) => a.baseline - b.baseline || a.box.x - b.box.x);
}

function sameStyle(a: Piece, b: PdfTextRun) {
  return a.font.name === b.font && a.font.bold === b.bold && a.font.italic === b.italic && Math.abs(a.size - b.size) < 0.6;
}

function buildLine(pieces: Piece[]): PdfTextLine {
  pieces.sort((a, b) => a.x - b.x);
  const runs: PdfTextRun[] = [];
  let text = "";
  let previous = null as Piece | null;
  for (const piece of pieces) {
    const gap = previous ? piece.x - previous.right : 0;
    const em = Math.max(piece.size, previous?.size ?? 0);
    const tab = previous !== null && gap > em * 1.6;
    const space = previous !== null && !tab && gap > em * 0.12 && !/\s$/.test(text) && !/^\s/.test(piece.text);
    const joiner = tab ? "\t" : space ? " " : "";
    const last = runs[runs.length - 1];
    if (last && !tab && sameStyle(piece, last)) {
      last.text += joiner + piece.text;
      last.width = piece.right - last.x;
    } else {
      if (last && joiner === " ") last.text += " ";
      runs.push({ text: piece.text, x: piece.x, width: piece.right - piece.x, size: piece.size, font: piece.font.name, bold: piece.font.bold, italic: piece.font.italic, ...(tab ? { gapBefore: true } : {}) });
    }
    text += joiner + piece.text;
    previous = piece.right > (previous?.right ?? -Infinity) ? piece : previous;
  }
  // The line's style is the one most of its letters are set in.
  const weight = new Map<string, { run: PdfTextRun; chars: number }>();
  for (const run of runs) {
    const key = `${run.font}|${run.size}|${run.bold}|${run.italic}`;
    const entry = weight.get(key) ?? { run, chars: 0 };
    entry.chars += run.text.replace(/\s/g, "").length;
    weight.set(key, entry);
  }
  const main = [...weight.values()].sort((a, b) => b.chars - a.chars)[0]!.run;
  const mainPieces = pieces.filter((piece) => Math.abs(piece.size - main.size) < 0.6);
  const baseline = median(mainPieces.map((piece) => piece.baseline));
  const top = Math.min(...pieces.map((piece) => piece.baseline - piece.size * 0.75));
  const bottom = Math.max(...pieces.map((piece) => piece.baseline + piece.size * 0.25));
  const left = Math.min(...pieces.map((piece) => piece.x));
  const right = Math.max(...pieces.map((piece) => piece.right));
  return {
    text: text.replace(/[  ]+/g, " ").trim(),
    box: { x: round(left), y: round(top), width: round(right - left), height: round(bottom - top) },
    baseline: round(baseline),
    size: main.size,
    font: main.font,
    bold: main.bold,
    italic: main.italic,
    runs: runs.map((run) => ({ ...run, x: round(run.x), width: round(run.width) })),
  };
}

export function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function round(value: number) {
  return Math.round(value * 100) / 100;
}

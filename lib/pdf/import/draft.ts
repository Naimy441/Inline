import { lineMetrics } from "@/lib/doc/fontMetrics";
import { mathTex, type MathBar, type MathGlyph, type MathPart } from "@/lib/pdf/import/mathText";
import { TEX_MATH_FONT } from "@/lib/pdf/import/text";
import type { PdfBox, PdfDocumentSummary, PdfPageAnalysis, PdfRule, PdfTextLine, PdfTextRun } from "@/lib/pdf/import/types";

/**
 * A first rebuild of a PDF page as Inline's layout Markdown, made from what
 * the PDF says rather than from how it looks: its lines are grouped into
 * paragraphs, headings, list items and displayed equations by where they
 * sit and what they're set in; each block gets the indents, alignment,
 * sizes, spacing, tab stops and frames that put its lines where they were;
 * equations are read back from their glyphs (lib/pdf/import/mathText.ts).
 *
 * Claude starts from this draft and fixes what it can't get right — mostly
 * equations — with the page's picture in front of it. The `concerns` say
 * where to look.
 */

export type DraftFace = { family: string; bold: boolean; italic: boolean };

export type DraftContext = {
  page: PdfPageAnalysis;
  summary: PdfDocumentSummary;
  /** The document's text area on the page, in points. */
  area: { left: number; top: number; width: number };
  /** The document's text size and line spacing (× size). */
  fontSize: number;
  lineSpacing: number;
  /** The family the document's text is set in. */
  family: string;
  /** The families the PDF's own fonts were kept as, by font name. */
  fonts: Record<string, DraftFace>;
  /** Drawings already cut out as pictures. */
  crops: Array<{ box: PdfBox; url: string }>;
  /** A letter's width in a PDF font, in ems, when the font is at hand: places letters exactly within their run. */
  advance?: (font: string, char: string) => number | null;
  /** A picture of a region of the page, if one was cut out (see PageDraft.needs). */
  cropFor?: (box: PdfBox) => string | null;
};

/** The draft, what to check in it, and regions to cut out as pictures before drafting again (equations that can't be read). */
export type PageDraft = { markdown: string; concerns: string[]; needs: PdfBox[] };

const GLUE = /^[\s\d()[\]=+−,.;:|/!'<>ΓΔΘΛΞΠΣΥΦΨΩˆ˜¯˙¨]+/;
const GLUE_END = /[\s\d()[\]=+−,.;:|/!'<>ΓΔΘΛΞΠΣΥΦΨΩˆ˜¯˙¨]+$/;
const MARKER = /^(\(?(?:\d{1,2}|[a-z]|[ivx]{1,4}|[A-Z])[.)]|•|∙|◦|▪|–|-)(?=\s)/;

type Token = { kind: "text"; run: PdfTextRun; text: string; x: number; right: number; tab: boolean } | { kind: "math"; glyphs: MathGlyph[]; parts: MathPart[]; x: number; right: number; tab: boolean };

type Segment = { kind: "text"; run: PdfTextRun; text: string; x: number; right: number; tab: boolean } | { kind: "math"; tex: string; flags: string[]; /** Its letters as the PDF has them. */ plain?: string; x: number; right: number; tab: boolean };

type Line = {
  source: PdfTextLine;
  segments: Segment[];
  x: number;
  right: number;
  baseline: number;
  size: number;
  /** Every letter outside equations is bold. */
  bold: boolean;
  /** Mostly an equation, set apart. */
  display: boolean;
  marker: string | null;
  frame: PdfRule | null;
};

type Block = { kind: "paragraph" | "heading" | "display"; lines: Line[]; frame: PdfRule | null } | { kind: "picture"; box: PdfBox; url: string; frame?: PdfRule | null };

const isMathRun = (run: PdfTextRun, size: number) => TEX_MATH_FONT.test(run.font) || Math.abs(run.dy ?? 0) > size * 0.12 || (run.size < size * 0.8 && !/[a-z]{3}/i.test(run.text));

const round1 = (value: number) => Math.round(value * 10) / 10;
const inches = (pt: number) => Math.round((pt / 72) * 1000) / 1000;

let advanceOf: DraftContext["advance"] = undefined;

/** Where each letter of a run starts and ends: by the font's widths when known (else shared out by length), fitted to the run. */
function positions(run: PdfTextRun) {
  const chars = [...run.text];
  const widths = chars.map((char) => (/\s/.test(char) ? 0.333 : (advanceOf?.(run.font, char) ?? 0.5)));
  const total = widths.reduce((sum, width) => sum + width, 0) || 1;
  const scale = run.width / total;
  const out: Array<{ x: number; right: number }> = [];
  let x = run.x;
  for (const width of widths) {
    out.push({ x, right: x + width * scale });
    x += width * scale;
  }
  return out;
}

/** Glyph-sized pieces of a run. */
function glyphsOf(run: PdfTextRun, from = 0, to = run.text.length): MathGlyph[] {
  const chars = [...run.text];
  const at = positions(run);
  const out: MathGlyph[] = [];
  for (let i = from; i < Math.min(to, chars.length); i += 1) {
    if (/\s/.test(chars[i]!)) continue;
    out.push({ text: chars[i]!, font: run.font, size: run.size, x: at[i]!.x, right: at[i]!.right, dy: run.dy ?? 0, bold: run.bold });
  }
  return out;
}

/** Where a run's text is from letter `from` to letter `to`. */
function spanOf(run: PdfTextRun, from: number, to: number) {
  const at = positions(run);
  if (!at.length) return { x: run.x, right: run.x + run.width };
  return { x: at[Math.min(from, at.length - 1)]!.x, right: at[Math.max(0, Math.min(to, at.length) - 1)]!.right };
}

/** Fractions: a short line over a short line, a bar between them, beside the line they belong to. */
function findFractions(lines: PdfTextLine[], rules: PdfRule[]) {
  const used = new Set<PdfTextLine>();
  const removed = new Set<PdfTextRun>();
  const parts = new Map<PdfTextLine, MathPart[]>();
  const bars = rules.filter((rule) => rule.kind === "hline" && rule.box.width < 200);
  const sorted = [...lines].sort((a, b) => a.baseline - b.baseline);
  for (const top of sorted) {
    if (used.has(top)) continue;
    for (const bottom of sorted) {
      if (bottom === top || used.has(bottom) || bottom.baseline <= top.baseline) continue;
      const size = Math.max(top.size, bottom.size);
      if (bottom.baseline - top.baseline > size * 2.8) break;
      const overlap = Math.min(top.box.x + top.box.width, bottom.box.x + bottom.box.width) - Math.max(top.box.x, bottom.box.x);
      if (overlap < Math.min(top.box.width, bottom.box.width) * 0.5) continue;
      const left = Math.min(top.box.x, bottom.box.x);
      const right = Math.max(top.box.x + top.box.width, bottom.box.x + bottom.box.width);
      const bar = bars.find((rule) => rule.box.y > top.baseline - 0.5 && rule.box.y < bottom.baseline - bottom.size * 0.5 && rule.box.x <= left + 1.5 && rule.box.x + rule.box.width >= right - 1.5);
      if (!bar) continue;
      // The line the fraction sits in: its baseline between the two, with nothing of its own where the fraction is.
      const host = sorted.find(
        (line) =>
          line !== top &&
          line !== bottom &&
          !used.has(line) &&
          line.baseline > top.baseline &&
          line.baseline < bottom.baseline &&
          !line.runs.some((run) => glyphsOf(run).some((glyph) => glyph.x < bar.box.x + bar.box.width - 0.5 && glyph.right > bar.box.x + 0.5)),
      );
      if (!host) continue;
      const num = mathTex(top.runs.flatMap((run) => glyphsOf(run)).map((glyph) => ({ ...glyph, dy: glyph.dy })), top.size, parts.get(top) ?? []).tex;
      const den = mathTex(bottom.runs.flatMap((run) => glyphsOf(run)), bottom.size, parts.get(bottom) ?? []).tex;
      // Numerator and denominator at full size in a line of text: \dfrac.
      parts.set(host, [...(parts.get(host) ?? []), { kind: "frac", x: bar.box.x, right: bar.box.x + bar.box.width, num, den, display: top.size >= host.size * 0.9 }]);
      used.add(top);
      used.add(bottom);
      break;
    }
  }
  // Scripts set apart from their line (limits over and under a sum): small lines just above or below another.
  for (const line of sorted) {
    if (used.has(line) || line.box.width > 60 || line.text.length > 12) continue;
    const host = sorted.find((other) => other !== line && !used.has(other) && other.size > line.size * 1.05 && Math.abs(other.baseline - line.baseline) < other.size * 1.1 && line.box.x >= other.box.x - 4 && line.box.x + line.box.width <= other.box.x + other.box.width + 4);
    if (!host) continue;
    const tex = mathTex(line.runs.flatMap((run) => glyphsOf(run)), line.size).tex;
    // Half a fraction: the other half is a raised or lowered run of the line, with a bar between them.
    const below = line.baseline > host.baseline;
    const left = line.box.x;
    const right = line.box.x + line.box.width;
    const partner = host.runs.find((run) => !removed.has(run) && (below ? (run.dy ?? 0) < -1 : (run.dy ?? 0) > 1) && run.x < right && run.x + run.width > left);
    const bar = partner && bars.find((rule) => rule.box.x <= Math.min(left, partner.x) + 1.5 && rule.box.x + rule.box.width >= Math.max(right, partner.x + partner.width) - 1.5 && Math.abs(rule.box.y - (below ? line.baseline - line.size * 0.8 : line.baseline + line.size * 0.4)) < line.size);
    if (partner && bar) {
      const other = mathTex(glyphsOf(partner).map((glyph) => ({ ...glyph, dy: 0 })), partner.size).tex;
      parts.set(host, [...(parts.get(host) ?? []), { kind: "frac", x: bar.box.x, right: bar.box.x + bar.box.width, num: below ? other : tex, den: below ? tex : other }]);
      removed.add(partner);
      used.add(line);
      continue;
    }
    // After the glyph it hangs from.
    const over = host.runs.flatMap((run) => glyphsOf(run)).find((glyph) => glyph.x < line.box.x + line.box.width && glyph.right > line.box.x);
    const x = over ? over.right - 0.01 : line.box.x;
    parts.set(host, [...(parts.get(host) ?? []), { kind: "tex", x, right: x + 0.01, tex: `${line.baseline < host.baseline ? "^" : "_"}{${tex}}` }]);
    used.add(line);
  }
  return { used, parts, removed };
}

/** A line's text and equations, in order. */
let skipRuns = new Set<PdfTextRun>();

function segmentsOf(line: PdfTextLine, parts: MathPart[], bars: MathBar[], display = false): Segment[] {
  const tokens: Token[] = [];
  for (const [index, run] of line.runs.entries()) {
    if (skipRuns.has(run)) continue;
    const tab = Boolean(run.gapBefore);
    // In a displayed equation only words set apart by spaces are text ("as", "where"); the rest is the equation's.
    if (display && !isMathRun(run, line.size)) {
      const chars = [...run.text];
      const text = chars.join("");
      const words = [...text.matchAll(/(?:^|\s)\p{L}{2,}(?:\s+\p{L}{2,})*(?=\s|:|$)/gu)].filter((match) => index === 0 || /^\s/.test(match[0]) || match.index! > 0);
      let at = 0;
      const push = (from: number, to: number, kind: "text" | "math") => {
        if (to <= from) return;
        const span = spanOf(run, from, to);
        if (kind === "math") tokens.push({ kind: "math", glyphs: glyphsOf(run, from, to), parts: [], ...span, tab: tab && from === 0 });
        else tokens.push({ kind: "text", run, text: chars.slice(from, to).join(""), ...span, tab: tab && from === 0 });
      };
      for (const match of words) {
        const from = [...text.slice(0, match.index!)].length;
        const to = from + [...match[0]].length;
        push(at, from, "math");
        push(from, to, "text");
        at = to;
      }
      push(at, chars.length, "math");
      continue;
    }
    if (isMathRun(run, line.size)) tokens.push({ kind: "math", glyphs: glyphsOf(run), parts: [], x: run.x, right: run.x + run.width, tab });
    else tokens.push({ kind: "text", run, text: run.text, x: run.x, right: run.x + run.width, tab });
  }
  for (const part of parts) tokens.push({ kind: "math", glyphs: [], parts: [part], x: part.x, right: part.right, tab: false });
  tokens.sort((a, b) => a.x - b.x);

  // Digits, brackets and operators set in the text font next to an equation are part of it.
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.kind !== "text") continue;
    const before = tokens[i - 1];
    const after = tokens[i + 1];
    const chars = [...token.text];
    let start = 0;
    let end = chars.length;
    if (before?.kind === "math" && !token.tab) {
      let lead = GLUE.exec(token.text)?.[0] ?? "";
      // A bracket after a space opens text of its own: "$\mu$ (< 50)".
      const open = /^\s+[([]/.exec(lead);
      if (open) lead = "";
      // The space after the equation is the text's.
      lead = lead.replace(/\s+$/, "");
      start = [...lead].length;
    }
    if (after?.kind === "math" && !after.tab) {
      // The space before the equation is the text's.
      const trail = (GLUE_END.exec(token.text)?.[0] ?? "").replace(/^.*\s/s, "");
      end = Math.max(start, chars.length - [...trail].length);
    }
    // Sentence punctuation after an equation stays text ("of $X$."), unless more equation follows.
    const dots = before?.kind === "math" && before.glyphs[before.glyphs.length - 1]?.text === ".";
    while (start > 0 && after?.kind !== "math" && /[\s.,;:!?]/.test(chars[start - 1]!) && !(dots && chars[start - 1] === ".")) start -= 1;
    if (start === 0 && end === chars.length) continue;
    const pieces: Token[] = [];
    if (start > 0) pieces.push({ kind: "math", glyphs: glyphsOf(token.run, 0, start), parts: [], ...spanOf(token.run, 0, start), tab: token.tab });
    if (end > start) {
      const text = chars.slice(start, end).join("");
      if (text.trim()) pieces.push({ kind: "text", run: token.run, text, ...spanOf(token.run, start, end), tab: token.tab && start === 0 });
      else if (start > 0 && end < chars.length) pieces.push({ kind: "text", run: token.run, text: " ", ...spanOf(token.run, start, end), tab: false });
    }
    if (end < chars.length) pieces.push({ kind: "math", glyphs: glyphsOf(token.run, end), parts: [], ...spanOf(token.run, end, chars.length), tab: false });
    tokens.splice(i, 1, ...pieces);
    i += pieces.length - 1;
  }

  // Neighbouring equation pieces are one equation; its own spaces are TeX's to make.
  const segments: Segment[] = [];
  let open: { glyphs: MathGlyph[]; parts: MathPart[]; x: number; right: number; tab: boolean } | null = null;
  let spaceBefore = false;
  const close = () => {
    if (!open) return;
    if (open.glyphs.length || open.parts.length) {
      const result = mathTex(open.glyphs, line.size, open.parts, bars);
      if (result.tex) segments.push({ kind: "math", tex: result.tex, flags: result.flags, plain: open.glyphs.map((glyph) => glyph.text).join(""), x: open.x, right: open.right, tab: open.tab });
    }
    open = null;
  };
  for (const token of tokens) {
    if (token.kind === "math") {
      // A bracket after a space starts an equation of its own: "$\mu$ ($< 50$)".
      if (open && spaceBefore && /^[([]/.test(token.glyphs[0]?.text ?? "")) close();
      if (open && token.tab) close();
      if (!open) {
        if (spaceBefore && segments.length) segments.push({ kind: "text", run: (segments.find((item) => item.kind === "text") as Extract<Segment, { kind: "text" }> | undefined)?.run ?? line.runs[0]!, text: " ", x: token.x, right: token.x, tab: false });
        open = { glyphs: [], parts: [], x: token.x, right: token.right, tab: token.tab };
      }
      open.glyphs.push(...token.glyphs);
      open.parts.push(...token.parts);
      open.right = Math.max(open.right, token.right);
      spaceBefore = false;
    } else {
      if (open && !token.text.trim() && !token.tab) {
        spaceBefore = true;
        continue;
      }
      const hadSpace = spaceBefore;
      close();
      spaceBefore = false;
      segments.push({ kind: "text", run: token.run, text: hadSpace && !/^\s/.test(token.text) ? ` ${token.text}` : token.text, x: token.x, right: token.right, tab: token.tab });
    }
  }
  close();
  // An equation's closing punctuation reads as the sentence's: "of $X$."
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (segment.kind !== "math") continue;
    const punctuation = /[.,;:]$/.exec(segment.tex)?.[0];
    const next = segments[i + 1];
    if (!punctuation || (next && next.kind === "math")) continue;
    segments[i] = { ...segment, tex: segment.tex.slice(0, -1) };
    const run = (segments.find((item) => item.kind === "text") as Extract<Segment, { kind: "text" }> | undefined)?.run ?? line.runs[0]!;
    if (next?.kind === "text") segments[i + 1] = { ...next, text: punctuation + next.text };
    else segments.splice(i + 1, 0, { kind: "text", run, text: punctuation, x: segment.right, right: segment.right, tab: false });
  }
  // Wide spaces are kept after a section number ("1  Introduction"); elsewhere they are a stretched line's.
  segments.forEach((segment, index) => {
    if (segment.kind !== "text") return;
    const keep = index === 0 ? /^\s*(?:§?\d+(?:\.\d+)*\.?|[A-Z]\.)[\u2002\u2003]/.exec(segment.text)?.[0].length ?? 0 : 0;
    segments[index] = { ...segment, text: (segment.text.slice(0, keep) + segment.text.slice(keep).replace(/[\u2002\u2003]/g, " ")).replace(/([\u2002\u2003])\s+/g, "$1") };
  });
  // Text after an equation needs its space back when the PDF had one.
  for (let i = 1; i < segments.length; i += 1) {
    const segment = segments[i]!;
    const previous = segments[i - 1]!;
    if (segment.tab) continue;
    if (segment.kind === "text" && previous.kind === "math" && !/^[\s.,;:!?)\]]/.test(segment.text) && segment.x - previous.right > line.size * 0.12) segments[i] = { ...segment, text: ` ${segment.text}` };
    if (segment.kind === "math" && previous.kind === "text" && !/[\s([]$/.test(previous.text) && segment.x - previous.right > line.size * 0.12) segments[i - 1] = { ...previous, text: `${previous.text} ` };
  }
  return segments;
}

/** Markdown's special characters in text, written so they read as text. */
function escapeText(text: string) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/([*_`~|])/g, "\\$1")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/\$/g, "&#36;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/ /g, "&emsp;")
    .replace(/ /g, "&ensp;")
    .replace(/\t/g, "&#9;");
}

/** Text at the start of a paragraph that Markdown would read as a list, heading or quote. */
function escapeStart(text: string) {
  return text.replace(/^(\d+)([.)])(?=\s|&)/, "$1\\$2").replace(/^([-+*#>])(?=\s|&)/, "\\$1");
}

export function draftPage(ctx: DraftContext): PageDraft {
  const { page, summary, area } = ctx;
  advanceOf = ctx.advance;
  const concerns: string[] = [];
  const areaRight = area.left + area.width;
  const areaCenter = area.left + area.width / 2;

  // The running header, footer and page numbers are the document's own.
  const chrome = (line: PdfTextLine) => {
    const near = (zone: { y: number; pages: number[] } | null | undefined) => Boolean(zone && zone.pages.includes(page.page) && Math.abs(line.baseline - zone.y) < 2);
    if (near(summary.header) || near(summary.footer)) return true;
    const numbers = summary.pageNumbers;
    return Boolean(numbers?.y !== undefined && Math.abs(line.baseline - numbers.y) < 2 && /^\s*\d+\s*$/.test(line.text));
  };
  const lines0 = page.lines.filter((line) => !chrome(line) && line.text.trim());
  const { used, parts, removed } = findFractions(lines0, page.rules);
  skipRuns = removed;
  const bars: MathBar[] = page.rules.filter((rule) => rule.kind === "hline" && rule.box.width < 120).map((rule) => ({ x: rule.box.x, right: rule.box.x + rule.box.width, y: rule.box.y }) as MathBar & { y: number });
  const frames = page.rules.filter((rule) => rule.kind === "frame");
  const frameOf = (line: PdfTextLine) => frames.find((frame) => line.baseline > frame.box.y && line.baseline < frame.box.y + frame.box.height && line.box.x >= frame.box.x - 1 && line.box.x + line.box.width <= frame.box.x + frame.box.width + 1) ?? null;

  const lines: Line[] = lines0
    .filter((line) => !used.has(line))
    .map((source) => {
      const own = bars.filter((bar) => {
        const y = (bar as MathBar & { y: number }).y;
        return y > source.baseline - source.size * 1.3 && y < source.baseline - source.size * 0.5 && bar.x >= source.box.x - 2 && bar.right <= source.box.x + source.box.width + 2;
      });
      let segments = segmentsOf(source, parts.get(source) ?? [], own);
      // An equation number at the right margin: \tag{1}.
      const tail = segments[segments.length - 1];
      const tag = tail?.kind === "text" && tail.tab && /^\s*\((\d+(?:\.\d+)?)\)\s*$/.exec(tail.text)?.[1];
      if (tag) segments = segments.slice(0, -1);
      const text = segments.filter((segment) => segment.kind === "text").map((segment) => (segment as { text: string }).text).join("");
      const mathWidth = segments.filter((segment) => segment.kind === "math").reduce((sum, segment) => sum + segment.right - segment.x, 0);
      const lastBox = segments[segments.length - 1];
      const width = (tag && lastBox ? lastBox.right - source.box.x : source.box.width) || 1;
      const center = source.box.x + width / 2;
      const words = text.replace(/[^\p{L}]+/gu, " ").trim().split(/\s+/).filter((word) => word.length > 1);
      const display = segments.some((segment) => segment.kind === "math") && mathWidth > width * 0.6 && words.length <= 2 && Math.abs(center - areaCenter) < area.width * 0.12 && width < area.width * 0.85;
      if (display) {
        segments = segmentsOf(source, parts.get(source) ?? [], own, true);
        if (tag) segments = segments.filter((segment, index) => !(index === segments.length - 1 && segment.kind === "text" && segment.tab));
        const last = segments[segments.length - 1];
        if (tag && last?.kind === "math") segments[segments.length - 1] = { ...last, tex: `${last.tex}\\tag{${tag}}` };
        else if (tag) segments.push({ kind: "math", tex: `\\tag{${tag}}`, flags: [], x: source.box.x + source.box.width, right: source.box.x + source.box.width, tab: false });
      }
      const first = segments[0];
      const marker = first?.kind === "text" ? (MARKER.exec(first.text.trimStart())?.[0] ?? null) : null;
      return {
        source,
        segments,
        x: source.box.x,
        right: source.box.x + source.box.width,
        baseline: source.baseline,
        size: source.size,
        bold: segments.some((segment) => segment.kind === "text" && segment.text.trim()) && segments.every((segment) => segment.kind !== "text" || !segment.text.trim() || segment.run.bold),
        display,
        marker,
        frame: frameOf(source),
      };
    })
    .sort((a, b) => a.baseline - b.baseline || a.x - b.x);

  // --- lines into blocks ---
  const gapOf = (size: number) => size * (summary.lineSpacing || 1.2);
  const blocks: Block[] = [];
  let current: (Block & { kind: "paragraph" | "heading" | "display" }) | null = null;
  const headingSize = ctx.fontSize * 1.12;
  for (const line of lines) {
    const kind = line.display ? "display" : line.size >= headingSize && line.bold ? "heading" : "paragraph";
    const previous = current?.lines[current.lines.length - 1];
    let join = Boolean(current && previous && current.kind === kind && kind !== "display");
    if (join && previous && current) {
      const right = line.frame ? line.frame.box.x + line.frame.box.width : areaRight;
      const gap = line.baseline - previous.baseline;
      const firstWord = (() => {
        const first = line.segments[0];
        if (!first) return 0;
        if (first.kind === "math") return first.right - first.x;
        const word = first.text.trimStart().split(/\s/)[0] ?? "";
        return ((first.right - first.x) * word.length) / Math.max(1, first.text.length);
      })();
      if (gap > gapOf(line.size) * 1.35 || gap < 0) join = false;
      else if (Math.abs(line.size - previous.size) > 0.6 || line.bold !== previous.bold) join = false;
      else if (line.frame !== previous.frame) join = false;
      else if (line.marker) join = false;
      else if (line.segments.some((segment) => segment.tab) || previous.segments.some((segment) => segment.tab)) join = false;
      // The line before stopped short of where this one's first word would have fit: a paragraph ended there.
      else if (previous.right + line.size * 0.33 + firstWord < right - 2 && Math.abs(previous.x + previous.right - 2 * areaCenter) > 4) join = false;
      else if (current.lines.length >= 2 && Math.abs(line.x - current.lines[1]!.x) > 2) join = false;
      else if (current.lines.length === 1 && line.x < previous.x - 1 && !previous.marker && kind !== "heading") join = Math.abs(line.x - (line.frame ? line.frame.box.x : area.left)) < 2 || line.x >= area.left + 2;
    }
    if (join && current) current.lines.push(line);
    else {
      current = { kind, lines: [line], frame: line.frame };
      blocks.push(current);
    }
  }
  // Equations that can't be read back — drawn in pieces, or with letters the PDF misnames — are pictures of the original until Claude writes them.
  const needs: PdfBox[] = [];
  const mathy = (block: Block) =>
    block.kind === "display" ||
    (block.kind === "paragraph" &&
      block.lines.every((line) => {
        const math = line.segments.filter((segment) => segment.kind === "math").reduce((sum, segment) => sum + segment.right - segment.x, 0);
        const words = line.segments.filter((segment) => segment.kind === "text").map((segment) => (segment as { text: string }).text).join(" ").replace(/[^\p{L}]+/gu, " ").trim().split(/\s+/).filter((word) => word.length > 1);
        // Mostly equation: little text, or none beyond a word (pieces of a formula set apart on a line of their own count too).
        const letters = line.segments.filter((segment) => segment.kind === "text").map((segment) => (segment as { text: string }).text).join("").replace(/[^\p{L}]/gu, "");
        return words.length <= 1 && (math >= (line.right - line.x) * 0.5 || line.segments.some((segment) => segment.kind === "math") || (letters.length <= 2 && line.size < ctx.fontSize * 0.85));
      }));
  const unreadable = (block: Block) => block.kind !== "picture" && block.lines.some((line) => line.segments.some((segment) => segment.kind === "math" && segment.flags.some((flag) => /couldn't read|misnames|doesn't typeset/.test(flag))));
  for (let i = 0; i < blocks.length; i += 1) {
    const start = blocks[i]!;
    if (!mathy(start) || start.kind === "picture") continue;
    let end = i;
    while (end + 1 < blocks.length) {
      const next = blocks[end + 1]!;
      const previous = blocks[end]!;
      if (next.kind === "picture" || previous.kind === "picture" || !mathy(next) || next.frame !== start.frame) break;
      const gap = next.lines[0]!.baseline - previous.lines[previous.lines.length - 1]!.baseline;
      if (gap > next.lines[0]!.size * 2.2) break;
      end += 1;
    }
    const cluster = blocks.slice(i, end + 1) as Array<Block & { lines: Line[] }>;
    const pieces = cluster.length > 1 && cluster.some((block) => block.kind !== "display");
    if (!pieces && !cluster.some(unreadable)) continue;
    const boxes = cluster.flatMap((block) => block.lines.map((line) => line.source.box));
    const x = Math.min(...boxes.map((box) => box.x)) - 2;
    const y = Math.min(...boxes.map((box) => box.y)) - 2;
    const box = { x, y, width: Math.max(...boxes.map((box) => box.x + box.width)) - x + 2, height: Math.max(...boxes.map((box) => box.y + box.height)) - y + 2 };
    const url = ctx.cropFor?.(box) ?? null;
    if (!url) {
      needs.push(box);
      continue;
    }
    concerns.push(`y ${round1(box.y)}–${round1(box.y + box.height)}: an equation the PDF ${pieces ? "draws in pieces" : "writes with letters it misnames"} is a picture of the original for now (${url}). Write it as LaTeX in its place.`);
    blocks.splice(i, cluster.length, { kind: "picture", box, url, frame: start.frame });
  }

  // Pictures and cropped drawings, in their place down the page.
  let pictures: Array<Block & { kind: "picture" }> = [
    ...page.images.filter((image) => image.url).map((image) => ({ kind: "picture" as const, box: image.box, url: image.url! })),
    ...ctx.crops.map((crop) => ({ kind: "picture" as const, box: crop.box, url: crop.url })),
  ];
  // Pictures beside or over one another (a row of charts, figures set diagonally) are one picture of that part of the page:
  // a paragraph can hold one row, and stacked they would take far more room than they do.
  const groups: Array<typeof pictures> = [];
  for (const picture of [...pictures].sort((a, b) => a.box.y - b.box.y)) {
    const group = groups.find((items) => items.some((other) => picture.box.y < other.box.y + other.box.height - 2 && picture.box.y + picture.box.height > other.box.y + 2));
    if (group) group.push(picture);
    else groups.push([picture]);
  }
  pictures = groups.flatMap((group) => {
    if (group.length < 2) return group;
    const x = Math.min(...group.map((item) => item.box.x));
    const y = Math.min(...group.map((item) => item.box.y));
    const box = { x, y, width: Math.max(...group.map((item) => item.box.x + item.box.width)) - x, height: Math.max(...group.map((item) => item.box.y + item.box.height)) - y };
    // Not over text: that would be drawn twice.
    if (lines.some((line) => line.source.box.x < box.x + box.width && line.source.box.x + line.source.box.width > box.x && line.source.box.y < box.y + box.height && line.source.box.y + line.source.box.height > box.y)) return group;
    const url = ctx.cropFor?.(box) ?? null;
    if (!url) {
      needs.push(box);
      return group;
    }
    return [{ kind: "picture" as const, box, url }];
  });
  const top = (block: Block) => (block.kind === "picture" ? block.box.y : block.lines[0]!.baseline - block.lines[0]!.size);
  const all = [...blocks, ...pictures].sort((a, b) => top(a) - top(b));

  // Where a line's baseline sits below the top of its line on the page (the font's ascent, and half the leading).
  const metrics = lineMetrics(ctx.family);
  const baselineOffset = (size: number, lh: number) => ((lh - metrics.ascent - metrics.descent) / 2 + metrics.ascent) * size;

  /** A frame's borders, the same on each paragraph in it so they share it: around the text with the space it had, and above its first line and below its last the space that puts their baselines where TeX did (TeX measures from the letters; a page's line is as tall as its font). */
  const frameAttrs = (frame: PdfRule) => {
    const inFrame = lines.filter((line) => line.frame === frame);
    const left = inFrame.length ? Math.min(...inFrame.map((line) => line.x)) : frame.box.x + 3;
    const out = [".box", `border-width=${round1(frame.width)}`, `border-space=${round1(Math.max(0, left - frame.box.x - frame.width))}`];
    const firstLine = inFrame[0];
    const lastLine = inFrame[inFrame.length - 1];
    if (firstLine) out.push(`border-space-top=${round1(Math.max(0, firstLine.baseline - frame.box.y - frame.width - baselineOffset(firstLine.size, ctx.lineSpacing)))}`);
    if (lastLine) out.push(`border-space-bottom=${round1(Math.max(0, frame.box.y + frame.box.height - frame.width - lastLine.baseline - (lastLine.size * ctx.lineSpacing - baselineOffset(lastLine.size, ctx.lineSpacing))))}`);
    return out;
  };

  // --- blocks into Markdown ---
  const out: string[] = [];
  let lastBottom: number | null = null;
  let lastFrame: PdfRule | null = null;
  const docLine = ctx.lineSpacing;

  for (const block of all) {
    if (block.kind === "picture") {
      // A picture in a paragraph of its own, placed where it was.
      const frame = block.frame ?? null;
      const left0 = frame ? Math.min(...lines.filter((line) => line.frame === frame).map((line) => line.x)) : area.left;
      const center = frame ? frame.box.x + frame.box.width / 2 : areaCenter;
      const centered = Math.abs(block.box.x + block.box.width / 2 - center) < 2;
      const before = lastBottom === null ? Math.max(0, block.box.y - area.top) : Math.max(0, block.box.y - lastBottom);
      // Its paragraph's text is tiny, so the line is no taller than the picture.
      const attrs = [centered ? "align=center" : block.box.x - left0 > 0.5 ? (frame ? `first-line=${inches(block.box.x - left0)}` : `left=${round1(block.box.x - left0)}`) : "", `before=${round1(before)}`, "after=0", "size=1", "line=1"];
      if (frame && left0 - area.left > 0.5) attrs.push(`left=${round1(left0 - area.left)}`);
      if (frame) attrs.push(...frameAttrs(frame));
      if (frame && lastFrame && frame !== lastFrame) out.push(`&nbsp; {size=1 before=0 after=0}`);
      out.push(`<img src="${block.url}" width="${Math.round((block.box.width * 4) / 3)}" height="${Math.round((block.box.height * 4) / 3)}"> {${attrs.filter(Boolean).join(" ")}}`);
      lastBottom = block.box.y + block.box.height;
      lastFrame = frame;
      continue;
    }
    const first = block.lines[0]!;
    const last = block.lines[block.lines.length - 1]!;
    const size = median(block.lines.map((line) => line.size));
    const lineHeight = block.lines.length > 1 ? median(block.lines.slice(1).map((line, index) => line.baseline - block.lines[index]!.baseline)) / size : null;
    const own = lineHeight && Math.abs(lineHeight - docLine) > 0.03 && lineHeight < 3 ? Math.round(lineHeight * 1000) / 1000 : null;
    const lh = own ?? docLine;
    // Space above: the baseline-to-baseline gap beyond a line's height (alignment measures and corrects it).
    const before = lastBottom === null ? Math.max(0, first.baseline - area.top - size * lh * 0.8) : Math.max(0, first.baseline - lastBottom - size * lh);
    const attrs: string[] = [];
    if (Math.abs(size - ctx.fontSize) > 0.25) attrs.push(`size=${round1(size)}`);
    if (own) attrs.push(`line=${own}`);

    // Frames: each paragraph in one says so; two frames in a row need a paragraph between them.
    const frame = block.frame;
    const left0 = frame ? Math.min(...lines.filter((line) => line.frame === frame).map((line) => line.x)) : area.left;
    if (frame && lastFrame && frame !== lastFrame) out.push(`&nbsp; {size=1 before=0 after=${round1(Math.max(0, frame.box.y - (lastFrame.box.y + lastFrame.box.height)) * 0.5)}}`);
    if (frame) attrs.push(...frameAttrs(frame));
    lastFrame = frame;

    const content = (line: Line, index: number) =>
      line.segments
        .map((segment) => {
          const tab = segment.tab ? "&#9;" : "";
          // An equation that wouldn't typeset is its letters, as text, until Claude writes it.
          if (segment.kind === "math") return segment.flags.some((flag) => /doesn't typeset/.test(flag)) && segment.plain ? tab + escapeText(segment.plain) : `${tab}$${segment.tex}$`;
          // TeX's bullet (\bullet) is the bullet operator, which the stand-in font has: text, not an equation.
          if (/^\s*[•∙]\s*$/.test(segment.text)) return `${tab}∙${/\s$/.test(segment.text) ? " " : ""}`;
          let text = escapeText(segment.text);
          if (!text.trim()) return tab + text;
          const lead = /^\s*/.exec(text)![0];
          const trail = /\s*$/.exec(text)![0];
          let body = text.trim();
          const run = segment.run;
          const isHeading = block.kind === "heading";
          if (run.bold && !isHeading) body = `**${body}**`;
          if (run.italic && !/^(cmti|cmsl|sfti)/i.test(run.font) && !run.bold) body = `*${body}*`;
          else if (run.italic && /^(cmti|sfti)/i.test(run.font)) body = `*${body}*`;
          if (isHeading) body = `**${body}**`;
          const face = ctx.fonts[run.font];
          const styles: string[] = [];
          if (face && face.family !== ctx.family && !/^[•∙◦▪–]$/.test(segment.text.trim())) styles.push(`font-family: '${face.family}'`);
          if (Math.abs(run.size - size) > 0.3 && Math.abs(run.dy ?? 0) < 0.5) styles.push(`font-size: ${round1(run.size)}pt`);
          if (styles.length) body = `<span style="${styles.join("; ")}">${body}</span>`;
          text = lead + body + trail;
          return tab + text;
        })
        .join("")
        .replace(index === 0 ? /^\s+/ : /^$/, "");

    // TeX centers a displayed equation in a list item over the item's text: so is it here, from that indent.
    const displayIndent = block.kind === "display" ? Math.max(0, 2 * ((first.x + first.right) / 2 - (frame ? (left0 + (frame.box.x + frame.box.width - (left0 - frame.box.x))) / 2 : areaCenter))) : 0;
    if (block.kind === "display" && !frame && displayIndent > 1.5) {
      const tex = block.lines.map((line) => line.segments.map((segment) => (segment.kind === "math" ? segment.tex : /^[\s.,;:]*$/.test(segment.text) ? segment.text.trim() : `\\text{ ${segment.text.trim()} }`)).join(" ")).join(" \\\\ ");
      out.push(`$\\displaystyle ${tex}$ {align=center left=${round1(displayIndent)} before=${round1(before)} after=0}`);
      noteMath(block, concerns);
      lastBottom = last.baseline;
      continue;
    }
    if (block.kind === "display" && !frame) {
      const tex = block.lines.map((line) => line.segments.map((segment) => (segment.kind === "math" ? segment.tex : /^[\s.,;:]*$/.test(segment.text) ? segment.text.trim() : `\\text{ ${segment.text.trim()} }`)).join(" ")).join(" \\\\ ");
      out.push(`$$\n${block.lines.length > 1 ? `\\begin{gathered}${tex}\\end{gathered}` : tex}\n$$ {before=${round1(before)} after=0}`);
      noteMath(block, concerns);
      lastBottom = last.baseline;
      continue;
    }
    if (block.kind === "display") {
      const tex = block.lines.map((line) => line.segments.map((segment) => (segment.kind === "math" ? segment.tex : /^[\s.,;:]*$/.test(segment.text) ? segment.text.trim() : `\\text{ ${segment.text.trim()} }`)).join(" ")).join(" \\\\ ");
      if (left0 - area.left > 0.5) attrs.push(`left=${round1(left0 - area.left)}`);
      out.push(`$\\displaystyle ${tex}$ {align=center before=${round1(before)} after=0 ${attrs.join(" ")}}`.replace(/ }$/, "}"));
      noteMath(block, concerns);
      lastBottom = last.baseline;
      continue;
    }

    // Indents, alignment and tab stops from where the lines sit.
    const firstX = first.x;
    const restX = block.lines.length > 1 ? block.lines[1]!.x : firstX;
    const right = frame ? frame.box.x + frame.box.width - (left0 - frame.box.x) : areaRight;
    const centered = block.lines.every((line) => Math.abs(line.x + line.right - 2 * (frame ? (left0 + right) / 2 : areaCenter)) < 4) && block.lines.every((line) => line.right < right - 6 || line.x > left0 + 6);
    const full = block.lines.length > 1 && block.lines.slice(0, -1).every((line) => Math.abs(line.right - right) < 2);
    const align = centered ? "center" : full ? "justify" : "left";
    let markerTab: number | null = null;
    if (!centered) {
      const indentFirst = firstX - left0;
      const indentRest = restX - left0;
      const textStart = first.marker ? (block.lines.length > 1 ? restX : afterMarker(first)) : null;
      if (frame) {
        // A frame follows its paragraph's indent: every paragraph in it starts where its text does, and only first lines indent further.
        if (left0 - area.left > 0.5) attrs.push(`left=${round1(left0 - area.left)}`);
        if (indentFirst > 1) attrs.push(`first-line=${inches(indentFirst)}`);
      } else {
        const leftIndent = Math.min(indentFirst, textStart !== null ? textStart - left0 : indentRest);
        if (leftIndent > 0.5) attrs.push(`left=${round1(leftIndent)}`);
        const firstOffset = indentFirst - (textStart !== null ? textStart - left0 : indentRest);
        if (firstOffset > 0.5) attrs.push(`first-line=${inches(firstOffset)}`);
        else if (firstOffset < -0.5) attrs.push(`hanging=${inches(-firstOffset)}`);
      }
      if (first.marker && textStart !== null) markerTab = textStart - area.left;
    }
    if (align !== "left") attrs.push(`align=${align}`);
    // Tab stops: where text after a wide gap starts (or ends, at the right margin, or centers).
    const stops: string[] = [];
    for (const line of block.lines) {
      line.segments.forEach((segment, index) => {
        if (!segment.tab) return;
        const lastOne = index === line.segments.length - 1 || line.segments.slice(index + 1).every((other) => !other.tab);
        const nextTab = line.segments.findIndex((other, k) => k > index && other.tab);
        const end = line.segments.slice(index, nextTab === -1 ? undefined : nextTab).reduce((max, other) => Math.max(max, other.right), segment.right);
        const middle = (segment.x + end) / 2;
        let stop: string;
        if (lastOne && Math.abs(end - right) < 3) stop = `${round1(end - area.left)}:right`;
        else if (Math.abs(middle - areaCenter) < 4) stop = `${round1(middle - area.left)}:center`;
        else stop = `${round1(segment.x - area.left)}:left`;
        if (!stops.includes(stop)) stops.push(stop);
      });
    }
    if (markerTab !== null) stops.unshift(`${round1(markerTab)}:left`);
    if (stops.length) attrs.push(`tabs="${stops.join(" ")}"`);
    if (block.kind === "heading") attrs.push("color=#000000");
    attrs.push(`before=${round1(before)}`, "after=0");

    // The text: lines joined (a word broken at a line's end joined again); centered lines keep their breaks.
    let text = "";
    block.lines.forEach((line, index) => {
      let piece = content(line, index);
      if (index === 0 && markerTab !== null && line.marker) {
        const escaped = /^[•∙]$/.test(line.marker) ? "∙" : escapeText(line.marker);
        piece = piece.replace(new RegExp(`^(\\*\\*)?${escaped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), (whole, bold) => `${bold ?? ""}${escaped}&#9;`);
      }
      if (index === 0) text = piece;
      else if (centered) text += `<br>${piece}`;
      else if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(piece)) text = text.slice(0, -1) + piece;
      else text += /\s$/.test(text) ? piece.trimStart() : ` ${piece.trimStart()}`;
    });
    text = escapeStart(text.replace(/\*\*\s*\*\*/g, " ").trim());
    const prefix = block.kind === "heading" ? (size >= ctx.fontSize * 1.15 ? "## " : "### ") : "";
    out.push(`${prefix}${text} {${attrs.join(" ")}}`);
    noteMath(block, concerns);
    lastBottom = last.baseline;
  }
  if (page.graphics.length > ctx.crops.length) concerns.push(`${page.graphics.length - ctx.crops.length} drawing(s) couldn't be cut out: crop them with crop_pdf_region.`);
  const header = summary.headerRule && summary.header ? summary.header.y : null;
  const loose = page.rules.filter((rule) => rule.kind === "hline" && rule.box.width >= area.width * 0.3 && !(header !== null && rule.box.y > header && rule.box.y < header + 20) && !lines.some((line) => Math.abs(line.baseline - rule.box.y) < line.size * 2));
  if (loose.length) concerns.push(`${loose.length} rule(s) across the page aren't in the draft (at y ${loose.map((rule) => round1(rule.box.y)).join(", ")}): add border=bottom or --- where they belong.`);
  return { markdown: out.join("\n\n"), concerns, needs };
}

/**
 * Where a list item's text starts after its label: measured back from the
 * end of the label's run by the letters' widths (and TeX's natural word
 * space), which is exact for a line that isn't stretched; never inside the label.
 */
function afterMarker(line: Line) {
  const first = line.segments[0];
  if (!first || first.kind !== "text" || !line.marker) return null;
  const run = first.run;
  const text = run.text;
  const at = text.indexOf(line.marker);
  if (at < 0) return null;
  let start = at + line.marker.length;
  while (start < text.length && /\s/.test(text[start]!)) start += 1;
  const width = (from: number, to: number) => [...text.slice(from, to)].reduce((sum, char) => sum + (/\s/.test(char) ? 0.333 : (advanceOf?.(run.font, char) ?? 0.5)), 0) * run.size;
  const markerEnd = run.x + width(0, at + line.marker.length);
  if (start >= text.trimEnd().length) return Math.max(markerEnd + 1, line.segments[1]?.x ?? markerEnd + run.size * 0.5);
  const textStart = run.x + run.width - width(start, text.trimEnd().length);
  return Math.max(markerEnd + 1, textStart);
}

function noteMath(block: Block & { lines: Line[] }, concerns: string[]) {
  for (const line of block.lines) {
    for (const segment of line.segments) {
      if (segment.kind !== "math" || !segment.flags.length) continue;
      concerns.push(`y ${round1(line.baseline)}: $${segment.tex}$ — has ${segment.flags.join(", ")}; check it against the picture.`);
    }
  }
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

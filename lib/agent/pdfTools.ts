import { readFile } from "node:fs/promises";
import type { Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { z } from "zod";
import { EditError, lockedBetween } from "@/lib/doc/editing";
import { markAgentText } from "@/lib/doc/merge";
import { parseMarkdown, serializeBlocks } from "@/lib/doc/markdown";
import { serializeLayoutBlock, serializeLayoutBlocks } from "@/lib/doc/layoutMarkdown";
import { mapHunks } from "@/lib/doc/review";
import { pageSize } from "@/lib/doc/settings";
import type { PdfBox, PdfPageAnalysis, PdfTextLine, PdfTextRun } from "@/lib/pdf/import/types";
import type { LiveDocument } from "@/lib/server/hub";
import { cropBitmap, inkBounds } from "@/lib/server/png";
import {
  cropRegion,
  isPlaceholder,
  pageBitmap,
  pageRanges,
  pagesLeft,
  inlineFontName,
  pdfImportFor,
  writePdfImport,
  type PageRange,
  type PdfImportRecord,
} from "@/lib/server/pdfImports";
import { RenderUnavailableError, requestPageRenders, type RenderedBlock, type RenderedPage } from "@/lib/server/renders";
import { lineBreaksFor } from "@/lib/agent/pdfLines";
import { pageColors, pageDraft } from "@/lib/server/pdfDrafts";
import { unexplainedMarks } from "@/lib/pdf/import/marks";
import { inkColor } from "@/lib/pdf/import/inkColor";
import { compareLines, coverMath, equationNote, formatMatch, innerMathNote, planAlignment, type AlignmentPlan, type BlockSpacing, type LineMatch, type MathSpan } from "@/lib/agent/pdfAlign";
import { MATH_LANGUAGE, TEXTBLOCK_TYPES } from "@/lib/doc/schema";
import { findUpload } from "@/lib/server/store";
import type { ToolContext, ToolDefinition, ToolResult } from "@/lib/agent/tools";

/**
 * Claude's tools for rebuilding an imported PDF as an editable document,
 * page by page (see lib/server/pdfImports.ts for how an import is kept, and
 * PDF_CONVERSION_GUIDE for how Claude is asked to work).
 *
 * They take tools.ts's helpers as an argument rather than importing them,
 * since tools.ts lists these tools among its own.
 */

export type PdfToolKit = {
  defineTool: <S extends z.ZodRawShape>(tool: ToolDefinition<S>) => ToolDefinition<S>;
  ok: (text: string) => ToolResult;
  fail: (text: string) => ToolResult;
  resolveDocument: (ctx: ToolContext, id?: string) => Promise<LiveDocument>;
  documentId: z.ZodOptional<z.ZodString>;
  showActivity: (ctx: ToolContext, doc: LiveDocument, activity: { chatId: string; status: "reading" | "editing" | "thinking" | "idle"; label: string; range?: { from: number; to: number } }) => void;
};

export const PDF_CONVERSION_GUIDE = `## Converting an imported PDF

The document was made from a PDF. It has one page per original page, separated by page breaks, and each page starts as a picture of the original (a placeholder). Your job is to rebuild every page as real, editable content in Inline's format, so that it looks like the original: same text, same structure, same fonts and sizes, same positions on the page. The user's handwriting, highlighting and other annotations were taken off the pictures you see; leave them out (the user can show them over the pages).

Inline drafts each page for you from the PDF itself: its exact words, fonts, sizes and colors, where every line sits, its frames and tab stops, code as the PDF sets it, and its equations read back from the glyphs TeX drew them with. The draft usually gets the text and layout right; what it can't be sure of it lists as concerns, and equations are its weak spot. Your job is to check each page against its picture and fix what the draft got wrong.

Work one page at a time:
1. read_pdf_page — the page as a picture, its text lines, and the draft with its concerns.
2. write_pdf_page — the draft, corrected: fix every flagged equation (read it from the picture; replace any equation the draft placed as a picture with LaTeX), and anything else that differs from the picture (a misread symbol, a heading that should be one, a list, a missing rule). Keep the draft's layout attributes unless the picture shows they're off. If the draft needs no change, use_draft: true writes it as it is. Write the whole page in one call; don't write \\pagebreak.
3. align_pdf_page — keeps the PDF's line breaks in every paragraph and sets the space around every block so each line lands at its height in the original, measuring in the editor until it matches. Leave vertical spacing to it. It reports the page as measured afterwards, the spacing it set, and what spacing couldn't fix and why.
4. compare_pdf_page — the original next to your page as the editor lays it out, with the text area, where your page's blocks run, and how far each line sits from where it should (lines matched one to one, in order down the page). Fix what alignment can't with edit_pdf_page (exact replacements in the page's layout Markdown, which read_pdf_page shows for a converted page; it keeps the blocks you don't touch as they are), then align_pdf_page again: wrong sizes, anything missing or extra, a page that runs onto a second one. Lines within ±3 pt of their original height are a match. An offset that grows within a block means its line spacing (line=) or size differs. A PDF line whose glyphs you replaced with LaTeX is inside a math block: the report says so, and whether the equation's position matches. It is not missing text. When one row inside a math block stays off, the report names that block and the row gap to change (\\\\[6pt]), not line=.
Change a page only with write_pdf_page, edit_pdf_page and align_pdf_page while converting: other editing tools mark their changes for the user to review, which a conversion shouldn't leave behind.
Only then the next page: compare every page, and don't finish with pages you haven't compared. Plan the pages with TodoWrite for long documents. When every page is done and matches, call finish_pdf_import.
If a tool says the editor hasn't laid the page out yet, it is busy (or reloading): call it again in a moment, more than once if needed, rather than skipping the check. Only when it keeps failing is the document closed; then say so to the user.

### Getting it right
- Transcribe exactly: every word, number and symbol, in order, nothing added, nothing "fixed". Copy words from the text lines (they are exact); for math and symbols trust the picture, since the text layer often garbles them (minus signs, ∼, ∗, accents, superscripts).
- Math is LaTeX: $…$ in text and $$…$$ for displayed equations (centered on their own line; the closing line can carry spacing, "$$ {before=6 after=6}"). Match the original's notation: \\mathbb{P}, \\operatorname{Var}, \\sqrt{}, \\frac{}{}, \\sum_{x}, \\int_{-\\infty}^{z}, \\mathcal{N}, \\sim, \\cdot. A derivation over several lines is one $$\\begin{aligned}…\\end{aligned}$$ block with & alignment. Put an equation's own punctuation inside it. An equation number at the right margin ("(1)") is \\tag{1} inside the $$ block.
- Paragraphs: one per paragraph of the original; join the PDF's lines (don't keep its line breaks). <br> only where the original breaks a line on purpose.
- Headings: use # levels for the structure (the biggest section style as ##, the next ###, …; # only for a real document title), and match their look with **bold** and size= (Inline headings are otherwise light and gray): \`## **1 Variance and Standard Deviation (§3.3)** {size=14.3 before=18 after=8 color=#000000}\`.
- Keep the original's spacing inside lines: TeX leaves a wide gap after a section number ("1  Variance", "1.1  Standard Deviation"); write it with &ensp; or &emsp; so the text starts where it did.
- Lists keep their markers: Markdown lists for bullets and 1. 2. numbering; write other markers ((a), (1), •) as text.
- A frame around paragraphs (a definition or question box): \`{.box border-width=0.4 border-space=3}\` on each paragraph in the frame, including its heading line; neighbouring paragraphs with the same box share one frame, so two separate frames one after another need a paragraph between them: an empty one that also makes the gap, \`&nbsp; {size=1 after=40}\`. Displayed equations can't take a box; put them in a boxed paragraph as $\\displaystyle …$ with {align=center} when they belong inside a frame.
- Inside a frame, indent with a tab stop or first-line=, not left=: a frame follows its paragraph's indent, so an indented paragraph gets a frame of its own.
- A rule across the page: \`---\`, or border=bottom on the paragraph above it.
- Text lined up at tab stops (a table of contents with page numbers at the right, two-column multiple choice): \`Text&#9;Page {tabs="470:right"}\`. Tab positions are points from the left margin (the PDF x minus the left margin).
- Tables: Markdown tables for real tables of text. A table that is a picture in the PDF stays a picture.
- Pictures in the PDF are listed by read_pdf_page with their URLs: \`![what it shows](url){width=NN%}\`, NN being its share of the text width (given). Pictures side by side go in one paragraph as <img src="url" width="W" height="H"> (CSS pixels, 4/3 of points), with {align=center} or tab stops to place them.
- Drawings made of lines and curves (charts, diagrams, the drawing listed under "drawings") can't be rebuilt as text: crop_pdf_region cuts any region of the page out as a picture to place like the others. Crop generously; it trims white space. Also crop anything else that can't be expressed (a complex diagram, a picture with text drawn over it).
- Links: [text](url) for web links. Links within the document (a table of contents) stay plain text.
- Code (text in a monospaced font: a notebook cell, a program listing) is one paragraph per frame or listing, its lines split with <br> (an empty line is <br><br>) and indented with spaces, colored token by token as the PDF colors it: the draft writes it so. Keep it that way rather than one paragraph per line.
- A frame the page's edge cuts (a cell that runs on from the page before, or onto the next) has no line on that side: border="left right bottom" or border="top left right", with the frame's border-width, border-space and border-color.
- read_pdf_page lists marks the picture shows that the text layer doesn't have (text drawn as a picture, like a notebook's "In [1]:" labels, or a logo). Read them from the picture; write them as text or crop them, or leave them out when they sit outside the text area and say so.
- Vertical space: match where blocks sit. The gap between two blocks is set with after= on the first or before= on the second, in points; blank space left on the page (room to write under a question) is kept with a large after=. The text lines' y values tell you the gaps: a gap of one line is normal paragraph flow; more is extra space.
- Fonts and sizes: the document's font, size and line spacing were set from the PDF (see get_pdf_import); give a paragraph size= only when it differs. Text in another of the PDF's fonts goes in the font get_pdf_import names for it, with <span style="font-family: …">…</span> (a URL in TeX's typewriter font: "Computer Modern Typewriter").
- Color: color=#rrggbb on a paragraph, or <span style="color: #rrggbb">…</span>, for colored text.
- The running header, footer and page numbers are document settings (already set): don't write them on the pages. If they're wrong, fix them with update_document_settings.
- The text area is the same on every page (the margins; nothing else is reserved), and a page's first block keeps its before= at the top of every page, after a page break too. Changing the margins, font, size or line spacing moves every page: if you must, do it before converting, or run align_pdf_page on every converted page again afterwards.
- If a page overflows onto an extra page, tighten spacing (smaller before/after, line=) rather than leaving anything out: the tools say by how many points it runs over and which block didn't fit. A page that ends a little short is fine.

### Layout attributes
Block attributes go in braces at the end of a paragraph or heading, combined freely:
- size=12 (text size, pt) · before=6 after=6 (space above/below, pt) · line=1.2 (line height, × size) · left=18 (indent, pt) · align=center|right|justify · first-line=0.5 / hanging=0.5 (inches)
- .box, or border=bottom / border="top bottom" / border="left right bottom", with border-width=0.5 border-space=3 (pt; border-space-top= and the other sides for one side's own) border-color=#000000 border-style=solid|double|dotted|dashed
- tabs="234:center 470:right:dot" (tab stops in pt from the left margin: left|center|right|decimal, leader dot|hyphen|underscore|middleDot); a tab in text is &#9;
- color=#c00000 · font="Courier New" · highlight=#fff2a8 (the whole paragraph's text)
In text: <span style="color: #c00; font-size: 10pt; font-family: Courier New; background-color: #ff0">…</span>, and <img src="url" width="120" height="80"> for a picture in a line. read_document doesn't show these; read_pdf_page shows a converted page with all of them, as edit_pdf_page expects them. Bold or italic that ** or * can't mark where it falls (an operator inside code: "x<strong>=</strong>1") is <strong>…</strong> or <em>…</em>.`;

/** One line of a page as read_pdf_page lists it: its baseline, left edge, size and font, its text with bold and italic marked, and the colors of text that isn't black. */
function describeLine(line: PdfTextLine, colors: ReadonlyMap<PdfTextRun, string> = new Map()) {
  const math = /^(cmmi|cmsy|cmex|msbm|msam|cmr\d|eufm|rsfs|stix.*math|cambria ?math)/i;
  const text = line.runs
    .map((run, index) => {
      const lead = index === 0 ? "" : run.gapBefore ? " ⇥ " : "";
      const body = run.text;
      if (math.test(run.font) || !body.trim()) return lead + body;
      if (run.bold && run.italic) return `${lead}***${body.trim()}***${/\s$/.test(body) ? " " : ""}`;
      if (run.bold && !line.bold) return `${lead}**${body.trim()}**${/\s$/.test(body) ? " " : ""}`;
      if (run.italic && !line.italic && !/^(cmmi|cmti|sfti)/i.test(run.font)) return `${lead}*${body.trim()}*${/\s$/.test(body) ? " " : ""}`;
      return lead + body;
    })
    .join("")
    .replace(/\s+/g, (space) => (space.includes("⇥") ? space : " "))
    .trim();
  const style = `${line.font}${line.bold ? " bold" : ""}${line.italic ? " italic" : ""}`;
  const colored = new Map<string, string[]>();
  for (const run of line.runs) {
    const color = colors.get(run);
    if (!color || color === "#000000" || !run.text.trim()) continue;
    colored.set(color, [...(colored.get(color) ?? []), run.text.trim().slice(0, 24)]);
  }
  const all = colored.size === 1 && line.runs.every((run) => !run.text.trim() || colors.get(run) === [...colored.keys()][0]);
  const tint = colored.size ? `   [${all ? `all ${[...colored.keys()][0]}` : [...colored].map(([color, texts]) => `${color}: ${texts.slice(0, 4).map((text) => `"${text}"`).join(" ")}${texts.length > 4 ? " …" : ""}`).join("; ")}]` : "";
  return `${f(line.baseline).padStart(6)} ${f(line.box.x).padStart(6)} ${String(line.size).padStart(5)}  ${style}: ${text}${tint}`;
}

function f(value: number) {
  return (Math.round(value * 10) / 10).toFixed(1);
}

function pointsBox(box: { x: number; y: number; width: number; height: number }) {
  return `x ${f(box.x)}, y ${f(box.y)}, ${f(box.width)} × ${f(box.height)} pt`;
}

function textArea(doc: LiveDocument) {
  const { margins } = doc.meta.settings.pageSetup;
  const size = pageSize(doc.meta.settings.pageSetup);
  return { left: margins.left * 72, top: margins.top * 72, width: (size.width - margins.left - margins.right) * 72, height: (size.height - margins.top - margins.bottom) * 72 };
}

async function uploadBase64(url: string) {
  const id = /\/api\/uploads\/([A-Za-z0-9_-]+)\./.exec(url)?.[1];
  const upload = id ? await findUpload(id) : null;
  return upload ? (await readFile(upload.file)).toString("base64") : null;
}

function pageStatus(range: PageRange | undefined) {
  if (!range) return "missing (the page breaks between pages were changed)";
  if (range.nodes.some(isPlaceholder)) return "still the original picture (placeholder)";
  return `converted (${range.nodes.length} block${range.nodes.length === 1 ? "" : "s"})`;
}

/** Pages of the document an original page takes, from the editor's measured layout (0-based), or null when not measured. */
async function pagesTaken(doc: LiveDocument, range: PageRange) {
  // The editor measures a change within a second or so; give a busy one longer, and one still opening
  // (the document was just imported) time to connect.
  const deadline = Date.now() + 20_000;
  let layout = await doc.currentLayout(12_000);
  while (!layout && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    layout = await doc.currentLayout(Math.max(0, deadline - Date.now()));
  }
  if (!layout) return null;
  const starts = layout.starts;
  const pageOf = (pos: number) => starts.filter((start) => start <= pos).length;
  const first = pageOf(range.from);
  const last = pageOf(Math.max(range.from, range.to - 1));
  return { first, last, count: last - first + 1, pages: layout.pages };
}

/** Paragraphs that are just a picture from the PDF: where the picture's top was on the page, by block id. */
function pictureAnchors(range: PageRange, record: PdfImportRecord, page: number) {
  const tops = new Map<string, number>();
  const assets = record.pages[page - 1];
  for (const image of record.manifest.pages[page - 1]?.images ?? []) if (image.url) tops.set(image.url, image.box.y);
  for (const item of [...(assets?.crops ?? []), ...(assets?.equations ?? [])]) tops.set(item.url, item.box.y);
  const anchors = new Map<string, number>();
  for (const node of range.nodes) {
    if (!node.attrs.id || node.childCount !== 1 || node.firstChild?.type.name !== "image") continue;
    const top = tops.get(String(node.firstChild.attrs.src ?? ""));
    if (top !== undefined) anchors.set(String(node.attrs.id), top);
  }
  return anchors;
}

/** The ids of a page's first and last blocks, for the editor to say which pages they take. */
function spanOf(range: PageRange) {
  const first = range.nodes[0]?.attrs.id;
  const last = range.nodes[range.nodes.length - 1]?.attrs.id;
  return first && last ? { first: String(first), last: String(last) } : null;
}

/** How a page's blocks sit on the editor's pages: how many they take, where they run on the first, and what ran over. */
export type PageFit = {
  /** Pages of the document they take, and the first (0-based). */
  count: number;
  first: number;
  /** The text area of every page, in points from the top. */
  area: { top: number; bottom: number };
  /** Where the blocks start and end on the first page. */
  extent: { top: number; bottom: number } | null;
  /** About how much taller than the text area they are (points), and the first block that went onto the next page. */
  over: { points: number; block: string | null } | null;
  /** How far the last block runs past the bottom margin on a page they fit on (a frame's padding, a picture). */
  past: number;
};

/** A block named by its first words (lines it breaks itself kept apart), or by what it is. */
const snippet = (node: PMNode | undefined) => {
  if (!node) return "";
  const text = node.textBetween(0, node.content.size, " ", (leaf) => (leaf.type.name === "hard_break" ? " / " : "")).replace(/\s+/g, " ").trim();
  if (text) return text.length > 50 ? `${text.slice(0, 49)}…` : text;
  if (node.type.name === "image" || node.firstChild?.type.name === "inline_image") return "(picture)";
  return node.type.name === "paragraph" ? "(empty paragraph)" : `(${node.type.name.replace("_", " ")})`;
};

/** A page's fit, from a rendering of the run of its blocks (one asked for with a span). */
export function pageFit(doc: LiveDocument, range: PageRange, rendered: RenderedPage): PageFit | null {
  const span = rendered.span;
  if (!span) return null;
  const area = textArea(doc);
  const top = area.top;
  const bottom = area.top + area.height;
  const ids = new Set(range.nodes.map((node) => String(node.attrs.id ?? "")));
  const nodeOf = (id: string) => range.nodes.find((node) => node.attrs.id === id);
  const sheets = rendered.spanBlocks ?? [{ page: span.first, blocks: rendered.blocks ?? [] }];
  const ours = (blocks: RenderedBlock[]) => blocks.filter((block) => ids.has(block.id));
  const firstSheet = ours(sheets.find((sheet) => sheet.page === span.first)?.blocks ?? rendered.blocks ?? []);
  const pageHeight = pageSize(doc.meta.settings.pageSetup).height * 72;
  const extent = firstSheet.length ? { top: Math.min(...firstSheet.map((block) => block.top)), bottom: Math.min(pageHeight, Math.max(...firstSheet.map((block) => block.bottom))) } : null;
  const count = span.last - span.first + 1;
  let over: PageFit["over"] = null;
  if (count > 1) {
    const rest = sheets.filter((sheet) => sheet.page > span.first).map((sheet) => ({ page: sheet.page, blocks: ours(sheet.blocks) }));
    const next = rest.find((sheet) => sheet.blocks.length);
    const lastSheet = [...rest].reverse().find((sheet) => sheet.blocks.length);
    const spilled = lastSheet ? Math.min(pageHeight, Math.max(...lastSheet.blocks.map((block) => block.bottom))) - top + (lastSheet.page - span.first - 1) * (bottom - top) : 0;
    const used = extent ? extent.bottom - top : 0;
    const firstOut = next ? nodeOf([...next.blocks].sort((a, b) => a.top - b.top)[0]!.id) : undefined;
    const kept = Number(firstOut?.attrs.spaceBefore ?? 0) || 0;
    over = { points: Math.max(1, Math.round(used + spilled + kept - (bottom - top))), block: firstOut ? snippet(firstOut) : null };
  }
  const past = count === 1 && extent ? Math.max(0, Math.round((extent.bottom - bottom) * 10) / 10) : 0;
  return { count, first: span.first, area: { top, bottom }, extent, over, past };
}

/** "It fits on one page …" or what ran over, for the tools' reports. */
export function describeFit(fit: PageFit) {
  if (fit.count === 1) return `It fits on one page (page ${fit.first + 1} of the document)${fit.past >= 1 ? `, though its last block ends ${f(fit.past)} pt below the bottom margin (${f(fit.area.bottom)} pt)` : ""}.`;
  return `It runs onto ${fit.count === 2 ? "the next page" : `${fit.count - 1} more pages`} (pages ${fit.first + 1}-${fit.first + fit.count} of the document): about ${fit.over?.points ?? "?"} pt too tall for the text area (${f(fit.area.top)} to ${f(fit.area.bottom)} pt)${fit.over?.block ? `; the first block that didn't fit is "${fit.over.block}"` : ""}. It must fit on one: take that much out of its spacing, or check for something too tall.`;
}

/** The page's blocks rendered by the editor as a run (fonts, pictures and kept lines settled), with how they fit. */
async function measurePage(doc: LiveDocument, range: PageRange, scale: number) {
  const span = spanOf(range);
  if (!span) return null;
  const rendered = await requestPageRenders(doc, [], { scale, span });
  const page = rendered[0];
  const fit = page ? pageFit(doc, range, page) : null;
  return page && fit ? { page, fit } : null;
}

/** How many pages a page's blocks take in the editor, measured once its layout has settled. */
async function fitOf(doc: LiveDocument, range: PageRange) {
  const measured = await measurePage(doc, range, 0.5).catch(() => null);
  return measured?.fit ?? null;
}

function ranges(record: PdfImportRecord, doc: LiveDocument, page: number) {
  if (!Number.isInteger(page) || page < 1 || page > record.manifest.pageCount) throw new EditError(`The PDF has pages 1 to ${record.manifest.pageCount}.`);
  const all = pageRanges(doc.doc);
  return { all, range: all[page - 1] };
}

export function pdfTools(kit: PdfToolKit): ToolDefinition[] {
  const { defineTool, ok, fail, resolveDocument, documentId, showActivity } = kit;

  async function importOf(ctx: ToolContext, id?: string) {
    const doc = await resolveDocument(ctx, id);
    const record = await pdfImportFor(doc);
    if (!record) throw new EditError(`"${doc.meta.title}" wasn't imported from a PDF.`);
    return { doc, record };
  }

  /** Put a page's blocks in place of what it holds, as a conversion (not a change to review), and say how they fit. */
  async function replacePage(ctx: ToolContext, doc: LiveDocument, record: PdfImportRecord, page: number, range: PageRange, blocks: PMNode[], tool: string): Promise<ToolResult> {
    if (lockedBetween(doc.doc, range.from, range.to)) return fail("Part of this page is locked by the user, so it can't be replaced.");
    await ctx.beforeWrite?.(doc);
    const tr = new Transform(doc.doc);
    tr.replaceWith(range.from, range.to, blocks);
    if (!tr.docChanged || tr.doc.eq(doc.doc)) return fail("The page already has this content.");
    // A conversion isn't an edit to review: it is applied as it is, and can be undone from the version history.
    doc.applyTransform(tr, { kind: "system", label: "pdf-import" }, { hunks: mapHunks(doc.hunks, tr.mapping) });
    setCompared(doc, page, false);
    const written = pageRanges(doc.doc)[page - 1]!;
    showActivity(ctx, doc, { chatId: ctx.author, status: "editing", label: tool === "write_pdf_page" ? `Converted page ${page}` : `Corrected page ${page}`, range: { from: written.from, to: written.to } });
    doc.sendCommand({ kind: "scroll_to", from: written.from, to: Math.min(written.to, written.from + 1), version: doc.version });
    const meta = doc.meta.pdfImport;
    if (meta && !meta.converted.includes(page)) doc.setPdfImport({ converted: [...meta.converted, page] });
    ctx.onChange?.({ documentId: doc.id, title: doc.meta.title, tool, added: wordsIn(blocks), removed: 0 });
    const taken = await pagesTaken(doc, written);
    // Measured again once the editor has settled the page (fonts, pictures, kept line breaks).
    const fit = taken ? await fitOf(doc, written) : null;
    const left = pagesLeft(doc.doc, record.manifest.pageCount);
    const fits = !taken
      ? "The editor hasn't measured it yet; compare_pdf_page will wait for it."
      : fit
        ? describeFit(fit)
        : taken.count === 1
          ? `It fits on one page (page ${taken.first + 1} of the document).`
          : `It runs over ${taken.count} pages of the document (pages ${taken.first + 1}-${taken.last + 1}): it must fit on one.`;
    const done = tool === "write_pdf_page" ? `Wrote page ${page}: ${blocks.length} block${blocks.length === 1 ? "" : "s"}.` : `Changed page ${page} (${blocks.length} block${blocks.length === 1 ? "" : "s"}).`;
    return ok(`${done} ${fits}${left.length ? ` Pages still to convert: ${compactPages(left)}.` : " Every page is converted now; finish with finish_pdf_import once they all match."} Next: align_pdf_page with page ${page} (it sets the spacing, and often fixes a page that runs over), then compare_pdf_page.`);
  }


  return [
    defineTool({
      name: "get_pdf_import",
      title: "Get PDF import",
      description:
        "For a document imported from a PDF: what the PDF holds (pages, size, fonts, header and footer, annotations), what was set from it, which pages are converted to editable text, and the full guide to converting it. Call this first when converting an imported PDF.",
      shape: { document_id: documentId },
      write: false,
      async handler(args, ctx) {
        const { doc, record } = await importOf(ctx, args.document_id);
        const { manifest } = record;
        const summary = manifest.summary;
        const all = pageRanges(doc.doc);
        const status = manifest.pages.map((page) => `- Page ${page.page}: ${pageStatus(all[page.page - 1])}${page.ink.count ? " · had annotations" : ""}${page.scanned ? " · a scan (no text layer: read it from the picture)" : ""}`);
        const settings = doc.meta.settings;
        const size = pageSize(settings.pageSetup);
        const area = textArea(doc);
        const fonts = summary.fonts
          .map((font) => {
            const own = record.fonts?.[font.name];
            const inline = inlineFontName(font.name);
            const set = own
              ? `set in "${own.family}"${own.bold ? " bold" : ""}${own.italic ? " italic" : ""} (the PDF's own font)`
              : inline === "math"
                ? "math (write it as LaTeX)"
                : inline
                  ? `set in "${inline}"`
                  : "";
            return `${font.name}${font.bold ? " bold" : ""}${font.italic ? " italic" : ""} (${font.sizes.slice(0, 3).join("/")}pt, ${font.chars} letters${set ? `; ${set}` : ""})`;
          })
          .join("; ");
        const header = summary.header ? `"${summary.header.parts.join(" | ")}" (${summary.header.size}pt) on pages ${compactPages(summary.header.pages)}${summary.headerRule ? ", with a rule under it" : ""}` : "none";
        const footer = summary.footer ? `"${summary.footer.parts.join(" | ")}" on pages ${compactPages(summary.footer.pages)}` : "none";
        const inkPages = manifest.pages.filter((page) => page.ink.count).map((page) => page.page);
        const notes = manifest.pages.flatMap((page) => page.ink.notes.map((note) => `- Page ${page.page}, ${note.kind} note: "${note.text.slice(0, 300)}"`));
        showActivity(ctx, doc, { chatId: ctx.author, status: "reading", label: "Reading the PDF" });
        return ok(
          [
            `"${doc.meta.title}" (id ${doc.id}) was imported from "${record.fileName}": ${manifest.pageCount} page${manifest.pageCount === 1 ? "" : "s"}, ${f(size.width * 72)} × ${f(size.height * 72)} pt.`,
            "",
            "Pages:",
            ...status,
            "",
            "Set from the PDF (document settings; change them with update_document_settings if they look wrong):",
            `- Text area: left margin ${f(area.left)} pt, top ${f(area.top)} pt, ${f(area.width)} pt wide (margins ${settings.pageSetup.margins.top}" top, ${settings.pageSetup.margins.bottom}" bottom, ${settings.pageSetup.margins.left}" left, ${settings.pageSetup.margins.right}" right).`,
            `- Body text: ${summary.bodyFont} ${summary.bodySize}pt → font ${settings.fontFamily.split(",")[0]} ${settings.fontSize}pt, line spacing ${settings.lineSpacing} (a line every ${f(settings.lineSpacing * settings.fontSize)} pt), ${settings.paragraphSpacing} pt after each paragraph.`,
            `- Running header: ${header}${settings.headerFooter.header ? ` → header "${settings.headerFooter.header.replace(/\t/g, " ⇥ ")}"` : ""}.`,
            `- Footer: ${footer}. Page numbers: ${summary.pageNumbers ? `${summary.pageNumbers.position}, ${summary.pageNumbers.align} → on` : "none"}.`,
            `- Fonts in the PDF: ${fonts || "none (a scanned PDF)"}.`,
            "",
            inkPages.length ? `Annotations were found on page${inkPages.length === 1 ? "" : "s"} ${compactPages(inkPages)} and left out of the page pictures. Don't transcribe handwriting.` : "No annotations were found.",
            ...(notes.length ? ["Notes typed into annotations (not page content; mention them to the user if useful):", ...notes] : []),
            "",
            PDF_CONVERSION_GUIDE,
          ].join("\n"),
        );
      },
    }),

    defineTool({
      name: "read_pdf_page",
      title: "Read PDF page",
      description:
        "One page of an imported PDF: a picture of it (annotations removed) and what it holds: its text lines with exact words, positions (points from the top left), fonts, sizes and colors; rules and frames; pictures (with URLs to place them); drawings to crop; links. Then the draft to start from, or, for a page already converted, the page as it is now in layout Markdown with every attribute (for edit_pdf_page). Read a page before writing it with write_pdf_page.",
      shape: { document_id: documentId, page: z.number().int().min(1).describe("Page number in the PDF (1-based)."), draft: z.boolean().optional().describe("Also show the draft for a page that is already converted.") },
      write: false,
      async handler(args, ctx) {
        const { doc, record } = await importOf(ctx, args.document_id);
        const { range } = ranges(record, doc, args.page);
        const page = record.manifest.pages[args.page - 1]!;
        const assets = record.pages[args.page - 1]!;
        const image = await uploadBase64(assets.view);
        const area = textArea(doc);
        showActivity(ctx, doc, { chatId: ctx.author, status: "reading", label: `Reading page ${args.page} of the PDF`, ...(range ? { range: { from: range.from, to: range.to } } : {}) });
        const converted = Boolean(range?.nodes.length) && !range!.nodes.some(isPlaceholder);
        const current = converted
          ? [
              "",
              "The page as it is in the document now, as layout Markdown with every attribute (change parts of it with edit_pdf_page, quoting it exactly):",
              "<current>",
              serializeLayoutBlocks(range!.nodes),
              "</current>",
            ]
          : [];
        let drafted: string[] = [];
        if (!converted || args.draft) {
          const draft = await pageDraft(doc, record, args.page);
          drafted = [
            "",
            "Draft of this page, built from the PDF's text layer (text, fonts, sizes, colors, indents, alignment, spacing, frames, tab stops; equations read back from their glyphs). Start from it: compare it with the picture, fix what differs, and write the page with write_pdf_page (use_draft: true writes it as it is).",
            "<draft>",
            draft.markdown,
            "</draft>",
            draft.concerns.length ? `Check these first:\n${draft.concerns.map((concern) => `- ${concern}`).join("\n")}` : "Nothing in particular was flagged; still check every equation against the picture.",
          ];
        } else drafted = ["", "(The draft it was started from isn't shown for a converted page: read_pdf_page with draft: true shows it.)"];
        const colors = await pageColors(record, args.page).catch(() => new Map<PdfTextRun, string>());
        const bitmap = await pageBitmap(record, args.page).catch(() => null);
        const marks = bitmap && !page.scanned ? unexplainedMarks(bitmap, record.manifest.renderScale, page).map((box) => ({ ...box, color: inkColor(bitmap, record.manifest.renderScale, box) })) : [];
        const text = [describePage(page, record, area, range, colors, marks), ...current, ...drafted].join("\n");
        return { text, ...(image ? { images: [{ data: image, mimeType: "image/png" }] } : {}) };
      },
    }),

    defineTool({
      name: "crop_pdf_region",
      title: "Crop PDF region",
      description:
        "Cut a region of an imported PDF's page out as a picture (annotations removed), for a drawing, chart or anything else that can't be rebuilt as text. The box is in points from the page's top left (as read_pdf_page gives positions). White space around the content is trimmed. Returns the picture's URL and Markdown to place it, and shows you the crop.",
      shape: {
        document_id: documentId,
        page: z.number().int().min(1),
        x: z.number().min(0),
        y: z.number().min(0),
        width: z.number().min(2),
        height: z.number().min(2),
        trim: z.boolean().optional().describe("Trim white space around the content (default true)."),
        alt: z.string().optional().describe("What the picture shows."),
      },
      write: false,
      async handler(args, ctx) {
        const { doc, record } = await importOf(ctx, args.document_id);
        ranges(record, doc, args.page);
        const page = record.manifest.pages[args.page - 1]!;
        let box = { x: args.x, y: args.y, width: Math.min(args.width, page.width - args.x), height: Math.min(args.height, page.height - args.y) };
        if (args.trim !== false) {
          const bitmap = await pageBitmap(record, args.page);
          const scale = record.manifest.renderScale;
          const crop = cropBitmap(bitmap, box.x * scale, box.y * scale, box.width * scale, box.height * scale);
          const ink = inkBounds(crop);
          if (!ink) return fail("That region of the page is blank.");
          const pad = 2 * scale;
          const x0 = Math.max(0, ink.x - pad);
          const y0 = Math.max(0, ink.y - pad);
          box = { x: box.x + x0 / scale, y: box.y + y0 / scale, width: Math.min(crop.width - x0, ink.width + 2 * pad) / scale, height: Math.min(crop.height - y0, ink.height + 2 * pad) / scale };
        }
        const crop = await cropRegion(record, args.page, box);
        const area = textArea(doc);
        const percent = Math.min(100, Math.round((crop.width / area.width) * 100));
        const alt = (args.alt ?? "Figure").replace(/[[\]]/g, "");
        const preview = await uploadBase64(crop.url);
        return {
          text: [
            `Cropped ${pointsBox({ ...box, width: crop.width, height: crop.height })} of page ${args.page}: ${crop.url}`,
            `It is ${f(crop.width)} pt wide, ${percent}% of the text width. Place it with:`,
            `![${alt}](${crop.url}){width=${percent}%}`,
            `or in a line of text: <img src="${crop.url}" width="${Math.round(crop.width * (4 / 3))}" height="${Math.round(crop.height * (4 / 3))}" alt="${alt}">`,
          ].join("\n"),
          ...(preview ? { images: [{ data: preview, mimeType: "image/png" }] } : {}),
        };
      },
    }),

    defineTool({
      name: "write_pdf_page",
      title: "Write PDF page",
      description:
        "Write one page of an imported PDF as editable content: Markdown with layout attributes (see get_pdf_import). It replaces everything on that page of the document (its placeholder picture, or what was written before) and doesn't touch other pages. Reports how many pages it takes in the editor.",
      shape: {
        document_id: documentId,
        page: z.number().int().min(1).describe("Page number in the PDF (1-based)."),
        content: z.string().min(1).optional().describe("The page's content as Markdown with layout attributes. No \\pagebreak."),
        use_draft: z.boolean().optional().describe("Write read_pdf_page's draft of the page as it is, instead of content."),
      },
      write: true,
      async handler(args, ctx) {
        const { doc, record } = await importOf(ctx, args.document_id);
        const { range } = ranges(record, doc, args.page);
        if (!range) return fail(`Page ${args.page} isn't in the document any more: it has fewer page breaks than the PDF has pages. Read the document and restore the page breaks first.`);
        const content = args.use_draft ? (await pageDraft(doc, record, args.page)).markdown : args.content;
        if (!content) return fail("Give the page's content, or use_draft: true to write its draft.");
        const blocks = parseMarkdown(content)
          .filter((node) => node.type.name !== "page_break")
          .map((node) => markAgentText(node));
        if (!blocks.length) return fail("The content parsed to nothing.");
        if (lockedBetween(doc.doc, range.from, range.to)) return fail("Part of this page is locked by the user, so it can't be replaced.");
        return replacePage(ctx, doc, record, args.page, range, blocks, "write_pdf_page");
      },
    }),

    defineTool({
      name: "edit_pdf_page",
      title: "Edit PDF page",
      description:
        "Change part of a converted page of an imported PDF without writing it all again: exact-string replacements in the page's layout Markdown (read_pdf_page shows it as it is now, with every attribute: before=, size=, frames, colors, spans). Each old_string must match exactly and once (unless replace_all). Blocks you don't touch keep everything they have, including the line breaks align_pdf_page kept. Like write_pdf_page, it isn't a change for the user to review.",
      shape: {
        document_id: documentId,
        page: z.number().int().min(1).describe("Page number in the PDF (1-based)."),
        edits: z
          .array(z.object({ old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().optional() }))
          .min(1)
          .describe("Replacements, applied in order, each to the result of the one before; if one fails, none is made."),
      },
      write: true,
      async handler(args, ctx) {
        const { doc, record } = await importOf(ctx, args.document_id);
        const { range } = ranges(record, doc, args.page);
        if (!range) return fail(`Page ${args.page} isn't in the document any more.`);
        if (range.nodes.some(isPlaceholder)) return fail(`Page ${args.page} is still the original picture: write it with write_pdf_page first.`);
        const before = range.nodes.map((node) => serializeLayoutBlock(node));
        let text = before.join("\n\n");
        for (const [index, edit] of args.edits.entries()) {
          const count = text.split(edit.old_string).length - 1;
          if (!count) return fail(`Edit ${index + 1}: old_string isn't on the page${args.edits.length > 1 && index > 0 ? " (after the edits before it)" : ""}. Read the page's layout Markdown with read_pdf_page; it must match exactly, attributes included.`);
          if (count > 1 && !edit.replace_all) return fail(`Edit ${index + 1}: old_string is on the page ${count} times. Give more of the text around it, or replace_all: true.`);
          text = edit.replace_all ? text.split(edit.old_string).join(edit.new_string) : text.replace(edit.old_string, () => edit.new_string);
        }
        // border-space past the cap is dropped on parse, which used to look like the edit was already there.
        const tooWide = frameWidthError(text);
        if (tooWide) return fail(tooWide);
        const parsed = parseMarkdown(text).filter((node) => node.type.name !== "page_break");
        if (!parsed.length) return fail("The page would be empty.");
        // Blocks written as they were stay the blocks they were (their ids, and the line breaks kept from the PDF).
        const unchanged = new Map<string, PMNode[]>();
        range.nodes.forEach((node, index) => unchanged.set(before[index]!, [...(unchanged.get(before[index]!) ?? []), node]));
        const blocks = parsed.map((node) => {
          const same = unchanged.get(serializeLayoutBlock(node));
          // A block Claude rewrote is Claude's text. A block left as it was keeps the marks it had.
          return same?.length ? same.shift()! : markAgentText(node);
        });
        return replacePage(ctx, doc, record, args.page, range, blocks, "edit_pdf_page");
      },
    }),

    defineTool({
      name: "compare_pdf_page",
      title: "Compare PDF page",
      description:
        "Compare a converted page with the original: shows the original page and the page as the editor lays it out (the way it would print); gives the document's text area and where the page's blocks run on it (and how far it runs over, if it does); and lists how far each line sits from its place in the original, in points, lines matched one to one in order down the page. A line inside a math block is not missing text; the report says whether that equation's position matches. Use it after align_pdf_page and fix what differs. Needs the document open in the editor.",
      shape: { document_id: documentId, page: z.number().int().min(1).describe("Page number in the PDF (1-based).") },
      write: false,
      async handler(args, ctx) {
        const { doc, record } = await importOf(ctx, args.document_id);
        const { range } = ranges(record, doc, args.page);
        if (!range) return fail(`Page ${args.page} isn't in the document any more.`);
        let taken = await pagesTaken(doc, range);
        if (!taken) return fail("The editor hasn't laid the page out yet: it may be busy, or the document isn't open. Try again in a moment; if it keeps failing, ask the user to open the document in Inline.");
        showActivity(ctx, doc, { chatId: ctx.author, status: "reading", label: `Comparing page ${args.page}`, range: { from: range.from, to: range.to } });
        let rendered;
        try {
          const span = spanOf(range);
          rendered = await requestPageRenders(doc, span ? [] : [taken.first], { scale: 2, ...(span ? { span } : {}) });
          const measured = rendered[0]?.span;
          if (measured) {
            taken = { ...taken, first: measured.first, last: measured.last, count: measured.last - measured.first + 1 };
            // A page that runs over: the next sheet too, to show what spilled.
            if (taken.count > 1) rendered = [rendered[0]!, ...(await requestPageRenders(doc, [measured.first + 1], { scale: 2 }))];
          }
        } catch (error) {
          if (error instanceof RenderUnavailableError) return fail(error.message);
          throw error;
        }
        if (!rendered.length) return fail("The editor couldn't picture the page.");
        const original = await uploadBase64(record.pages[args.page - 1]!.view);
        const analysis = record.manifest.pages[args.page - 1]!;
        const covered = coverMath(compareLines(analysis.lines, rendered[0]!.lines ?? []), analysis.lines, mathSpans(range, rendered[0]!.blocks ?? []));
        const report = covered.matches;
        const placed = report.filter((row) => row.rendered !== null);
        const inMath = report.filter((row) => row.math);
        const missing = report.filter((row) => row.rendered === null && !row.math);
        const offsets = placed.map((row) => row.rendered! - row.original);
        const worst = placed.reduce<(typeof placed)[number] | null>((acc, row) => (!acc || Math.abs(row.rendered! - row.original) > Math.abs(acc.rendered! - acc.original) ? row : acc), null);
        const lines = report.map((row) => formatMatch(row));
        const mathNote = equationNote(inMath);
        const summary = placed.length
          ? `Lines found: ${placed.length} of ${report.length}.${inMath.length ? ` ${inMath.length} more ${inMath.length === 1 ? "is" : "are"} inside a math block, not missing text.` : ""}${missing.length ? ` ${missing.length} missing.` : ""} Offsets from the original: ${f(Math.min(...offsets))} to ${f(Math.max(...offsets))} pt${worst ? ` (largest at "${worst.text}")` : ""}. Within ±3 pt is a match; a steady drift means spacing above that point is off.${mathNote ? ` ${mathNote}` : ""}`
          : inMath.length
            ? `No text line matched by its words. ${inMath.length} ${inMath.length === 1 ? "line is" : "lines are"} inside a math block, not missing text. ${mathNote}`
            : "No lines could be matched by their words (a page of equations or pictures): compare the pictures.";
        const images = [...(original ? [{ data: original, mimeType: "image/png" }] : []), ...rendered.map((page) => ({ data: Buffer.from(page.png).toString("base64"), mimeType: "image/png" }))];
        const fit = pageFit(doc, range, rendered[0]!);
        const settings = doc.meta.settings.pageSetup.margins;
        // Where the original's content runs, to set beside where the page's blocks do.
        const inOriginal = originalExtent(analysis);
        const geometry = fit
          ? [
              `Text area of the document's pages: ${f(fit.area.top)} to ${f(fit.area.bottom)} pt from the top (margins ${settings.top}" top, ${settings.bottom}" bottom; the same on every page, with nothing else reserved). ${fit.extent ? `Your page's blocks run from ${f(fit.extent.top)} to ${f(fit.extent.bottom)} pt` : "Your page has no blocks on its first sheet"}${inOriginal && !inOriginal.continuation ? `; the original's content from ${f(inOriginal.top)} to ${f(inOriginal.bottom)} pt` : ""}.`,
              inOriginal?.continuation ? originalExtentSentence(inOriginal) : "",
              fit.count > 1 || fit.past >= 1 ? describeFit(fit) : "",
            ]
          : [];
        setCompared(doc, args.page, true);
        return {
          text: [
            `Page ${args.page}: the first picture is the original, ${rendered.length === 1 ? "the second is your page" : "the next two are your page and the one it runs onto"} (page ${taken.first + 1} of the document)${taken.count > 1 ? `. It takes ${taken.count} pages: it must fit on one.` : "."}`,
            ...geometry.filter(Boolean),
            summary,
            "Baselines in points from the top (original, yours, difference):",
            ...lines,
          ].join("\n"),
          images,
        };
      },
    }),

    defineTool({
      name: "align_pdf_page",
      title: "Align PDF page",
      description:
        "Line a converted page up with the original: keeps the PDF's line breaks in every paragraph, measures where each block's first line sits in the editor against the PDF, and sets the space above and below blocks so every line lands at its original height, repeating until it matches; a page that runs onto the next has its largest gaps narrowed first. A math block with no matched words is moved onto the equation. A line inside one math block that spacing can't move names that block and the row gap to change. Reports the result as measured at the end, the spacing it set, and anything spacing couldn't fix (with why). Run it after write_pdf_page or edit_pdf_page (it changes only spacing), then check with compare_pdf_page. Needs the document open in the editor.",
      shape: { document_id: documentId, page: z.number().int().min(1).describe("Page number in the PDF (1-based).") },
      write: true,
      async handler(args, ctx) {
        const { doc, record } = await importOf(ctx, args.document_id);
        const analysis = record.manifest.pages[args.page - 1];
        if (!analysis) return fail(`The PDF has pages 1 to ${record.manifest.pageCount}.`);
        {
          const { range } = ranges(record, doc, args.page);
          if (!range) return fail(`Page ${args.page} isn't in the document any more.`);
          if (range.nodes.some(isPlaceholder)) return fail(`Page ${args.page} is still the original picture: write it with write_pdf_page first.`);
          if (!(await pagesTaken(doc, range))) return fail("The editor hasn't laid the page out yet: it may be busy, or the document isn't open. Try again in a moment.");
        }
        await ctx.beforeWrite?.(doc);
        showActivity(ctx, doc, { chatId: ctx.author, status: "editing", label: `Lining up page ${args.page}` });
        // First the paragraphs keep the PDF's line breaks, so every line holds the words it held there.
        {
          const { range } = ranges(record, doc, args.page);
          if (range) {
            const locked = lineBreaksFor(doc.doc, range.from, range.to, analysis.lines);
            if (locked.length) {
              const tr = new Transform(doc.doc);
              for (const { pos, value } of locked) tr.setNodeAttribute(pos, "lineBreaks", value);
              doc.applyTransform(tr, { kind: "system", label: "pdf-lines" }, { hunks: mapHunks(doc.hunks, tr.mapping) });
              setCompared(doc, args.page, false);
            }
          }
        }
        // The spacing every block had before, to report what changed.
        const was = new Map<string, { text: string; spaceBefore: number | null; spaceAfter: number | null }>();
        const remember = (node: PMNode) => {
          const id = String(node.attrs.id ?? "");
          if (id && !was.has(id)) was.set(id, { text: snippet(node), spaceBefore: node.attrs.spaceBefore ?? null, spaceAfter: node.attrs.spaceAfter ?? null });
        };
        const apply = (patches: Map<string, Record<string, number>>) => {
          const tr = new Transform(doc.doc);
          doc.doc.forEach((node, pos) => {
            const patch = patches.get(String(node.attrs.id ?? ""));
            if (!patch) return;
            remember(node);
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch });
          });
          if (!tr.docChanged) return false;
          doc.applyTransform(tr, { kind: "system", label: "pdf-align" }, { hunks: mapHunks(doc.hunks, tr.mapping) });
          setCompared(doc, args.page, false);
          return true;
        };
        const measure = async () => {
          const { range } = ranges(record, doc, args.page);
          if (!range) return `Page ${args.page} isn't in the document any more.`;
          try {
            const measured = await measurePage(doc, range, 1);
            if (!measured) return "The editor didn't say where the page's blocks are.";
            return { range, ...measured };
          } catch (error) {
            if (error instanceof RenderUnavailableError) return error.message;
            throw error;
          }
        };
        const plan = (measured: { range: PageRange; page: RenderedPage }): AlignmentPlan => {
          const { range, page } = measured;
          // Only the blocks of this original page (a page that overflows starts the next one's blocks on the same sheet).
          const ids = new Set(range.nodes.map((node) => String(node.attrs.id ?? "")));
          const blocks = (page.blocks ?? []).filter((block) => ids.has(block.id));
          const spacing = (id: string): BlockSpacing | null => {
            const node = range.nodes.find((item) => item.attrs.id === id);
            if (!node) return null;
            // Paragraphs, headings and displayed equations take spacing of their own.
            const spaced = TEXTBLOCK_TYPES.has(node.type.name) || (node.type.name === "code_block" && node.attrs.language === MATH_LANGUAGE);
            return { spaceBefore: node.attrs.spaceBefore ?? null, spaceAfter: node.attrs.spaceAfter ?? null, canBefore: spaced, canAfter: spaced };
          };
          const spans = mathSpans(range, blocks);
          const covered = coverMath(compareLines(analysis.lines, page.lines ?? []), analysis.lines, spans);
          // A math block whose glyphs became LaTeX has no words to match; move it onto the equation.
          const anchors = pictureAnchors(range, record, args.page);
          for (const [id, top] of covered.anchors) if (!anchors.has(id)) anchors.set(id, top);
          return planAlignment(analysis.lines, page.lines ?? [], blocks, spacing, 0.75, anchors);
        };
        // A page that runs onto another has its largest gap narrowed, a step at a time; then it is lined up again.
        const shrinkLargestGap = () => {
          const { range } = ranges(record, doc, args.page);
          if (!range) return false;
          let target: { id: string; space: number } | null = null;
          for (const node of range.nodes) {
            const space = node.attrs.spaceBefore;
            if (node.isTextblock && typeof space === "number" && space > 4 && (!target || space > target.space)) target = { id: String(node.attrs.id ?? ""), space };
          }
          const found = target as { id: string; space: number } | null;
          if (!found?.id) return false;
          return apply(new Map([[found.id, { spaceBefore: Math.max(0, Math.round((found.space - Math.max(12, found.space * 0.25)) * 10) / 10) }]]));
        };

        // Measure, set the spacing, and measure again: a few rounds settle what one can't (lines that wrap differently).
        const MEASUREMENTS = 7;
        let rounds = 0;
        while (rounds < MEASUREMENTS) {
          const measured = await measure();
          if (typeof measured === "string") return fail(measured);
          rounds += 1;
          if (measured.fit.count > 1 && rounds < MEASUREMENTS && shrinkLargestGap()) continue;
          if (!measured.page.blocks?.length || !measured.page.lines) return fail("The editor didn't report where the page's blocks are.");
          const next = plan(measured);
          if (!next.changes.size || rounds === MEASUREMENTS) break;
          if (!apply(next.changes as Map<string, Record<string, number>>)) break;
        }
        // Still running onto another page once lined up: narrow its largest gaps until it fits.
        for (let round = 0; round < 8; round += 1) {
          const { range } = ranges(record, doc, args.page);
          const fit = range ? await fitOf(doc, range) : null;
          if (!fit || fit.count === 1 || !shrinkLargestGap()) break;
        }

        // The page as it is now, measured.
        const final = await measure();
        if (typeof final === "string") return fail(final);
        const spans = mathSpans(final.range, (final.page.blocks ?? []).filter((block) => final.range.nodes.some((node) => node.attrs.id === block.id)));
        const covered = coverMath(compareLines(analysis.lines, final.page.lines ?? []), analysis.lines, spans);
        const report = covered.matches;
        const placed = report.filter((row) => row.rendered !== null);
        const inMath = report.filter((row) => row.math);
        const missing = report.filter((row) => row.rendered === null && !row.math);
        const offsets = placed.map((row) => row.rendered! - row.original);
        const off = placed.filter((row) => Math.abs(row.rendered! - row.original) > 3);
        const stuck = plan(final).stuck;
        const changed = final.range.nodes.flatMap((node) => {
          const before = was.get(String(node.attrs.id ?? ""));
          if (!before) return [];
          const parts: string[] = [];
          const now = { spaceBefore: node.attrs.spaceBefore ?? null, spaceAfter: node.attrs.spaceAfter ?? null };
          if (now.spaceBefore !== before.spaceBefore) parts.push(`before ${before.spaceBefore ?? "–"}→${now.spaceBefore ?? "–"}`);
          if (now.spaceAfter !== before.spaceAfter) parts.push(`after ${before.spaceAfter ?? "–"}→${now.spaceAfter ?? "–"}`);
          return parts.length ? [`"${before.text}" ${parts.join(", ")}`] : [];
        });
        const signed = (value: number) => `${value >= 0 ? "+" : ""}${f(value)}`;
        // A row inside one math block is not a line= problem: name the block and what can move it.
        const inner: string[] = [];
        const explained = new Set<LineMatch>();
        for (const row of off) {
          const block = (final.page.blocks ?? []).find((item) => row.rendered! >= item.top - 1 && row.rendered! <= item.bottom + 1);
          const span = block ? spans.find((item) => item.id === block.id) : undefined;
          if (!block || !span) continue;
          const first = report.find((item) => item.rendered !== null && item.rendered >= block.top - 1 && item.rendered <= block.bottom + 1);
          const firstMatches = Boolean(first && first !== row && Math.abs(first.rendered! - first.original) <= 3);
          inner.push(firstMatches ? innerMathNote(row.text, row.rendered! - row.original, span.text) : `"${row.text.slice(0, 40)}" (${signed(row.rendered! - row.original)} pt) is inside the math block "${span.text}". Change before= on that block to move the equation; line= does not move a row inside it.`);
          explained.add(row);
        }
        const unexplained = off.filter((row) => !explained.has(row));
        const out = [
          `Lined up page ${args.page} (${rounds} measurement${rounds === 1 ? "" : "s"}), then measured it again:`,
          placed.length
            ? `${placed.length} of ${report.length} lines found; ${placed.length - off.length} within ±3 pt of the original (${f(Math.min(...offsets))} to ${f(Math.max(...offsets))} pt)${off.length ? "" : ": a match"}.`
            : inMath.length
              ? ""
              : "No line could be matched by its words (a page of equations or pictures): compare the pictures with compare_pdf_page.",
          missing.length ? `${missing.length} line${missing.length === 1 ? "" : "s"} of the original weren't found on the page (missing, or worded differently): compare_pdf_page lists them.` : "",
          inMath.length ? `${inMath.length} line${inMath.length === 1 ? "" : "s"} ${inMath.length === 1 ? "is" : "are"} inside a math block, not missing text. ${equationNote(inMath)}` : "",
          unexplained.length ? `Still off by more than 3 pt: ${unexplained.slice(0, 8).map((row) => `"${row.text.slice(0, 40)}" ${signed(row.rendered! - row.original)}`).join("; ")}${unexplained.length > 8 ? `; and ${unexplained.length - 8} more` : ""}.` : "",
          stuck.length ? `What spacing can't fix:\n${stuck.slice(0, 6).map((item) => `- "${item.text.slice(0, 40)}" (${signed(item.offset)} pt): ${item.reason}.`).join("\n")}` : "",
          inner.length ? `A line inside one math block:\n${inner.map((note) => `- ${note}`).join("\n")}` : "",
          unexplained.length && !stuck.length ? "Lines off within a block whose first line matches: its line spacing (line=) or size differs from the original, or its lines wrap differently." : "",
          changed.length ? `Spacing set (pt): ${changed.slice(0, 12).join("; ")}${changed.length > 12 ? `; and ${changed.length - 12} more blocks` : ""}.` : "No spacing needed changing.",
          final.fit.count > 1 || final.fit.past >= 1 ? describeFit(final.fit) : "",
          "Check it with compare_pdf_page.",
        ];
        return ok(out.filter(Boolean).join("\n"));
      },
    }),

    defineTool({
      name: "finish_pdf_import",
      title: "Finish PDF import",
      description: "Mark an imported PDF's conversion as finished, once every page is written, compared with compare_pdf_page, and matches the original. Refuses until every page has been compared, and says which pages are left. Reports pages that are still pictures.",
      shape: { document_id: documentId },
      write: true,
      async handler(args, ctx) {
        const { doc, record } = await importOf(ctx, args.document_id);
        const left = pagesLeft(doc.doc, record.manifest.pageCount);
        if (left.length) return fail(`Page${left.length === 1 ? "" : "s"} ${compactPages(left)} ${left.length === 1 ? "is" : "are"} still the original picture. Convert ${left.length === 1 ? "it" : "them"} with read_pdf_page and write_pdf_page first.`);
        const unseen = uncomparedPages(record.manifest.pageCount, doc.meta.pdfImport?.compared ?? []);
        if (unseen.length) return fail(uncomparedMessage(unseen));
        record.finishedAt = Date.now();
        await writePdfImport(record);
        doc.setPdfImport({ status: "done" });
        return ok(`The conversion of "${record.fileName}" is finished: all ${record.manifest.pageCount} pages are editable. ${doc.meta.pdfImport?.inkPages.length ? "The user can show the original annotations over the pages from the View menu." : ""}`.trim());
      },
    }),

    defineTool({
      name: "show_pdf_annotations",
      title: "Show PDF annotations",
      description: "Show or hide the annotations (handwriting, highlighting, notes) an imported PDF had, drawn over the document's pages where they were on the original pages. They don't move with edits.",
      shape: { document_id: documentId, show: z.boolean() },
      write: true,
      async handler(args, ctx) {
        const { doc } = await importOf(ctx, args.document_id);
        const meta = doc.meta.pdfImport;
        if (!meta?.inkPages.length) return fail("This PDF had no annotations.");
        doc.setPdfImport({ showAnnotations: args.show });
        return ok(args.show ? `Showing the annotations on page${meta.inkPages.length === 1 ? "" : "s"} ${compactPages(meta.inkPages)}.` : "Hid the annotations.");
      },
    }),
  ] as unknown as ToolDefinition[];
}

function wordsIn(blocks: PMNode[]) {
  return serializeBlocks(blocks).split(/\s+/).filter(Boolean).length;
}

/** Remember which pages compare_pdf_page has checked. Writing or lining a page up clears it. */
function setCompared(doc: LiveDocument, page: number, seen: boolean) {
  const meta = doc.meta.pdfImport;
  if (!meta) return;
  const compared = new Set(meta.compared ?? []);
  if (seen) compared.add(page);
  else compared.delete(page);
  const next = [...compared].sort((a, b) => a - b);
  const prev = [...(meta.compared ?? [])].sort((a, b) => a - b);
  if (next.join() === prev.join()) return;
  doc.setPdfImport({ compared: next });
}

/** Pages that have not been compared since they were written or lined up. */
export function uncomparedPages(pageCount: number, compared: readonly number[]) {
  const seen = new Set(compared);
  const left: number[] = [];
  for (let page = 1; page <= pageCount; page += 1) if (!seen.has(page)) left.push(page);
  return left;
}

/** finish_pdf_import's refusal, naming the pages still to compare. */
export function uncomparedMessage(pages: number[]) {
  const list = compactPages(pages);
  return pages.length === 1
    ? `Page ${list} hasn't been compared. compare_pdf_page it before finish_pdf_import.`
    : `Pages ${list} haven't been compared. compare_pdf_page each of them before finish_pdf_import.`;
}

/**
 * border-space layoutAttrs will keep (lib/doc/markdown.ts). A larger padding is
 * how a frame would extend past the text width, and parse drops it, so an edit
 * must say so instead of claiming the page already has that content.
 */
const MAX_BORDER_SPACE = 40;

/** The frame-width error for Markdown that asks a frame to extend past the text, or null when the padding is allowed. */
export function frameWidthError(markdown: string): string | null {
  const bad: string[] = [];
  for (const match of markdown.matchAll(/border-space(?:-(top|right|bottom|left))?=(\d+(?:\.\d+)?)(?:pt)?/g)) {
    const value = Number(match[2]);
    if (!Number.isFinite(value) || (value >= 0 && value <= MAX_BORDER_SPACE)) continue;
    bad.push(`border-space${match[1] ? `-${match[1]}` : ""}=${match[2]}`);
  }
  if (!bad.length) return null;
  return `A frame cannot extend past the text width (${bad.join(", ")}). The page was not changed.`;
}

/** A displayed equation, or a paragraph that is only math: its glyphs are LaTeX now. */
function isMathBlock(node: PMNode) {
  if (node.type.name === "code_block" && node.attrs.language === MATH_LANGUAGE) return true;
  if (!node.isTextblock) return false;
  let math = 0;
  let other = 0;
  node.descendants((child) => {
    if (!child.isText) return;
    const text = (child.text ?? "").replace(/\s/g, "");
    if (!text) return;
    if (child.marks.some((mark) => mark.type.name === "math")) math += text.length;
    else other += text.length;
  });
  return math > 0 && other === 0;
}

function mathSpans(range: PageRange, blocks: RenderedBlock[]): MathSpan[] {
  const at = new Map(blocks.map((block) => [block.id, block]));
  const spans: MathSpan[] = [];
  for (const node of range.nodes) {
    if (!isMathBlock(node)) continue;
    const id = String(node.attrs.id ?? "");
    const box = at.get(id);
    if (!box) continue;
    spans.push({ id, top: box.top, bottom: box.bottom, text: snippet(node) });
  }
  return spans;
}

type ExtentPage = {
  height: number;
  lines: Array<{ box: PdfBox }>;
  images: Array<{ box: PdfBox }>;
  rules: Array<{ kind: string; box: PdfBox }>;
};

/** A frame or upright the page's top edge cuts: it continues from the page before. */
function clippedAtTop(rule: { kind: string; box: PdfBox }) {
  return (rule.kind === "frame" || rule.kind === "vline") && rule.box.y <= 1 && rule.box.height >= 12 && rule.box.y + rule.box.height > 1;
}

/**
 * Where the original page's content runs. A frame clipped at the top is a
 * continuation from the previous page, not a sign that the content starts at 0.
 */
export function originalExtent(page: ExtentPage): { top: number; bottom: number; continuation: boolean } | null {
  const uprights = page.rules.filter((rule) => rule.kind === "vline" && rule.box.y <= 1 && rule.box.height >= 12);
  const continuation = page.rules.some((rule) => rule.kind === "frame" && clippedAtTop(rule)) || uprights.length >= 2;
  const skip = new Set(page.rules.filter((rule) => continuation && (clippedAtTop(rule) || (rule.kind === "hline" && rule.box.y <= 1))));
  const marks = [...page.lines.map((line) => line.box), ...page.images.map((image) => image.box), ...page.rules.filter((rule) => !skip.has(rule)).map((rule) => rule.box)].filter((box) => box.y + box.height > 0 && box.y < page.height);
  if (!marks.length) return continuation ? { top: 0, bottom: 0, continuation: true } : null;
  return {
    top: Math.max(0, Math.min(...marks.map((box) => box.y))),
    bottom: Math.min(page.height, Math.max(...marks.map((box) => box.y + box.height))),
    continuation,
  };
}

/** The compare sentence for where the original's content runs. */
export function originalExtentSentence(extent: { top: number; bottom: number; continuation: boolean }) {
  if (!extent.continuation) return `the original's content from ${f(extent.top)} to ${f(extent.bottom)} pt`;
  const range = extent.bottom > extent.top ? ` The original's content runs from ${f(extent.top)} to ${f(extent.bottom)} pt.` : "";
  return `A frame continues from the previous page and is clipped at the top edge; that is not where the page's content starts.${range}`;
}

/** "1-3, 5" for [1, 2, 3, 5]. */
export function compactPages(pages: number[]) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j += 1;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return parts.join(", ");
}

/** read_pdf_page's description of a page. */
function describePage(page: PdfPageAnalysis, record: PdfImportRecord, area: ReturnType<typeof textArea>, range: PageRange | undefined, colors: ReadonlyMap<PdfTextRun, string> = new Map(), marks: Array<PdfBox & { color?: string | null }> = []) {
  const lines = page.lines.map((line) => describeLine(line, colors));
  const out = [
    `Page ${page.page} of ${record.manifest.pageCount} (${f(page.width)} × ${f(page.height)} pt), in the document: ${pageStatus(range)}.`,
    `The document's text area starts ${f(area.left)} pt from the left and ${f(area.top)} pt from the top, and is ${f(area.width)} pt wide. Positions are points from the page's top left; y is a line's baseline, x its left edge. ⇥ is a wide gap (a tab stop or a column).`,
    page.scanned ? "This page is a scan with no text layer: read everything from the picture." : "",
    page.ink.count ? `Annotations were removed from this page${page.ink.box ? ` (around ${pointsBox(page.ink.box)})` : ""}; don't look for them.` : "",
    "",
    lines.length ? "Text lines (y, x, size, font: text [colors of text that isn't black]):" : "No text lines.",
    ...lines,
  ];
  const rules = page.rules.filter((rule) => rule.kind !== "hline" || rule.box.width >= 12);
  if (rules.length) {
    out.push("", "Rules and frames:");
    for (const rule of rules) {
      if (rule.kind === "frame") {
        const inside = page.lines.filter((line) => line.baseline > rule.box.y && line.baseline < rule.box.y + rule.box.height && line.box.x >= rule.box.x - 2);
        out.push(`- frame ${pointsBox(rule.box)}, ${rule.width} pt line${inside.length ? `, around the lines from y ${f(inside[0]!.baseline)} ("${inside[0]!.text.slice(0, 40)}") to y ${f(inside[inside.length - 1]!.baseline)}` : ""}`);
      } else if (rule.kind === "hline") out.push(`- horizontal line at y ${f(rule.box.y)}, x ${f(rule.box.x)} to ${f(rule.box.x + rule.box.width)}, ${rule.width} pt${rule.color !== "#000000" ? `, ${rule.color}` : ""}`);
      else out.push(`- vertical line at x ${f(rule.box.x)}, y ${f(rule.box.y)} to ${f(rule.box.y + rule.box.height)}`);
    }
  }
  if (page.images.length) {
    out.push("", "Pictures (place them with these URLs):");
    for (const image of page.images) {
      const percent = Math.min(100, Math.round((image.box.width / area.width) * 100));
      out.push(`- ${image.id}: ${pointsBox(image.box)} (${percent}% of the text width; ${image.pixelWidth}×${image.pixelHeight} px)${image.url ? ` → ${image.url}` : " (couldn't be taken out: crop it with crop_pdf_region)"}`);
    }
  }
  if (page.graphics.length) {
    out.push("", "Drawings made of lines and curves (crop them with crop_pdf_region, with some room for their labels):");
    for (const box of page.graphics) out.push(`- ${pointsBox(box)}`);
  }
  if (marks.length) {
    const outside = (box: PdfBox) => box.x + box.width < area.left - 1 || box.x > area.left + area.width + 1;
    out.push("", "Marks the picture shows that aren't in the text layer, rules, pictures or drawings (text drawn as a picture or as outlines, a logo): read them from the picture, and write them as text or crop them with crop_pdf_region.");
    for (const box of marks.slice(0, 16)) out.push(`- ${pointsBox(box)}${box.color && box.color !== "#000000" ? `, ${box.color}` : ""}${outside(box) ? " (outside the document's text area: the left or right margin would have to move to hold it)" : ""}`);
    if (marks.length > 16) out.push(`- and ${marks.length - 16} more`);
  }
  if (page.links.length) {
    out.push("", "Links:");
    for (const link of page.links) out.push(`- "${link.text ?? ""}" → ${link.url ?? `page ${link.page}`}`);
  }
  return out.filter((line, index, all) => line !== "" || (index > 0 && all[index - 1] !== "")).join("\n");
}

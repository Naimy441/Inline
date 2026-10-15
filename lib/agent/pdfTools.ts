import { readFile } from "node:fs/promises";
import type { Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { z } from "zod";
import { EditError, lockedBetween } from "@/lib/doc/editing";
import { parseMarkdown, serializeBlocks } from "@/lib/doc/markdown";
import { mapHunks } from "@/lib/doc/review";
import { pageSize } from "@/lib/doc/settings";
import type { PdfPageAnalysis, PdfTextLine } from "@/lib/pdf/import/types";
import type { LiveDocument } from "@/lib/server/hub";
import { cropBitmap, inkBounds } from "@/lib/server/png";
import {
  cropRegion,
  isPlaceholder,
  pageBitmap,
  pageRanges,
  pagesLeft,
  pdfImportFor,
  writePdfImport,
  type PageRange,
  type PdfImportRecord,
} from "@/lib/server/pdfImports";
import { RenderUnavailableError, requestPageRenders } from "@/lib/server/renders";
import { compareLines, planAlignment, type BlockSpacing } from "@/lib/agent/pdfAlign";
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

Work one page at a time:
1. read_pdf_page — the page as a picture, with its text lines (exact words, positions, fonts, sizes), rules and frames, pictures and drawings.
2. write_pdf_page — the page's content as Markdown with layout attributes (below). It replaces that page (the placeholder, or what you wrote before). Don't write \\pagebreak: pages are kept apart for you. Write the whole page in one call.
3. align_pdf_page — sets the space above and below every block so each one's first line lands at its height in the original, measuring in the editor until it matches. Leave vertical spacing to it rather than tuning before=/after= by hand; give blocks your best estimate when writing, and it does the rest.
4. compare_pdf_page — the original next to your page as the editor lays it out, with how far each line sits from where it should. Fix what alignment can't (write_pdf_page again, then align_pdf_page again): different line breaks, wrong sizes, anything missing or extra, a page that runs onto a second one. Lines within ±3 pt of their original height are a match. An offset that grows within a block means its line spacing (line=) or size differs.
Only then the next page: compare every page, and don't finish with pages you haven't compared. Plan the pages with TodoWrite for long documents. When every page is done and matches, call finish_pdf_import.
If a tool says the editor hasn't laid the page out yet, it is busy (or reloading): call it again in a moment, more than once if needed, rather than skipping the check. Only when it keeps failing is the document closed; then say so to the user.

### Getting it right
- Transcribe exactly: every word, number and symbol, in order, nothing added, nothing "fixed". Copy words from the text lines (they are exact); for math and symbols trust the picture, since the text layer often garbles them (minus signs, ∼, ∗, accents, superscripts).
- Math is LaTeX: $…$ in text and $$…$$ for displayed equations (centered on their own line; the closing line can carry spacing, "$$ {before=6 after=6}"). Match the original's notation: \\mathbb{P}, \\operatorname{Var}, \\sqrt{}, \\frac{}{}, \\sum_{x}, \\int_{-\\infty}^{z}, \\mathcal{N}, \\sim, \\cdot. A derivation over several lines is one $$\\begin{aligned}…\\end{aligned}$$ block with & alignment. Put an equation's own punctuation inside it.
- Paragraphs: one per paragraph of the original; join the PDF's lines (don't keep its line breaks). <br> only where the original breaks a line on purpose.
- Headings: use # levels for the structure (the biggest section style as ##, the next ###, …; # only for a real document title), and match their look with **bold** and size= (Inline headings are otherwise light and gray): \`## **1 Variance and Standard Deviation (§3.3)** {size=14.3 before=18 after=8 color=#000000}\`.
- Keep the original's spacing inside lines: TeX leaves a wide gap after a section number ("1  Variance", "1.1  Standard Deviation"); write it with &ensp; or &emsp; so the text starts where it did.
- Lists keep their markers: Markdown lists for bullets and 1. 2. numbering; write other markers ((a), (1), •) as text.
- A frame around paragraphs (a definition or question box): \`{.box border-width=0.4 border-space=3}\` on each paragraph in the frame, including its heading line; neighbouring paragraphs with the same box share one frame, so two separate frames one after another need a paragraph between them: an empty one that also makes the gap, \`&nbsp; {size=1 after=40}\`. Displayed equations can't take a box; put them in a boxed paragraph as $\\displaystyle …$ with {align=center} when they belong inside a frame.
- A rule across the page: \`---\`, or border=bottom on the paragraph above it.
- Text lined up at tab stops (a table of contents with page numbers at the right, two-column multiple choice): \`Text&#9;Page {tabs="470:right"}\`. Tab positions are points from the left margin (the PDF x minus the left margin).
- Tables: Markdown tables for real tables of text. A table that is a picture in the PDF stays a picture.
- Pictures in the PDF are listed by read_pdf_page with their URLs: \`![what it shows](url){width=NN%}\`, NN being its share of the text width (given). Pictures side by side go in one paragraph as <img src="url" width="W" height="H"> (CSS pixels, 4/3 of points), with {align=center} or tab stops to place them.
- Drawings made of lines and curves (charts, diagrams, the drawing listed under "drawings") can't be rebuilt as text: crop_pdf_region cuts any region of the page out as a picture to place like the others. Crop generously; it trims white space. Also crop anything else that can't be expressed (a complex diagram, a picture with text drawn over it).
- Links: [text](url) for web links. Links within the document (a table of contents) stay plain text.
- Vertical space: match where blocks sit. The gap between two blocks is set with after= on the first or before= on the second, in points; blank space left on the page (room to write under a question) is kept with a large after=. The text lines' y values tell you the gaps: a gap of one line is normal paragraph flow; more is extra space.
- Fonts and sizes: the document's font, size and line spacing were set from the PDF (see get_pdf_import); give a paragraph size= only when it differs, and use <span style="font-family: …">…</span> only for text in another font (code in Courier).
- Color: color=#rrggbb on a paragraph, or <span style="color: #rrggbb">…</span>, for colored text.
- The running header, footer and page numbers are document settings (already set): don't write them on the pages. If they're wrong, fix them with update_document_settings.
- If a page overflows onto an extra page, tighten spacing (smaller before/after, line=) rather than leaving anything out. A page that ends a little short is fine.

### Layout attributes
Block attributes go in braces at the end of a paragraph or heading, combined freely:
- size=12 (text size, pt) · before=6 after=6 (space above/below, pt) · line=1.2 (line height, × size) · left=18 (indent, pt) · align=center|right|justify · first-line=0.5 / hanging=0.5 (inches)
- .box, or border=bottom / border="top bottom", with border-width=0.5 border-space=3 (pt) border-color=#000000 border-style=solid|double|dotted|dashed
- tabs="234:center 470:right:dot" (tab stops in pt from the left margin: left|center|right|decimal, leader dot|hyphen|underscore|middleDot); a tab in text is &#9;
- color=#c00000 · font="Courier New" · highlight=#fff2a8 (the whole paragraph's text)
In text: <span style="color: #c00; font-size: 10pt; font-family: Courier New; background-color: #ff0">…</span>, and <img src="url" width="120" height="80"> for a picture in a line. These are applied but not shown when you read the document back.`;

/** One line of a page as read_pdf_page lists it: its baseline, left edge, size and font, and its text with bold and italic marked. */
function describeLine(line: PdfTextLine) {
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
  return `${f(line.baseline).padStart(6)} ${f(line.box.x).padStart(6)} ${String(line.size).padStart(5)}  ${style}: ${text}`;
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
  // The editor measures a change within a second or so; give a busy one longer.
  const layout = await doc.currentLayout(12_000);
  if (!layout) return null;
  const starts = layout.starts;
  const pageOf = (pos: number) => starts.filter((start) => start <= pos).length;
  const first = pageOf(range.from);
  const last = pageOf(Math.max(range.from, range.to - 1));
  return { first, last, count: last - first + 1, pages: layout.pages };
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
        const fonts = summary.fonts.map((font) => `${font.name}${font.bold ? " bold" : ""}${font.italic ? " italic" : ""} (${font.sizes.slice(0, 3).join("/")}pt, ${font.chars} letters)`).join("; ");
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
        "One page of an imported PDF: a picture of it (annotations removed) and what it holds: its text lines with exact words, positions (points from the top left), fonts and sizes; rules and frames; pictures (with URLs to place them); drawings to crop; links. Read a page before writing it with write_pdf_page.",
      shape: { document_id: documentId, page: z.number().int().min(1).describe("Page number in the PDF (1-based).") },
      write: false,
      async handler(args, ctx) {
        const { doc, record } = await importOf(ctx, args.document_id);
        const { range } = ranges(record, doc, args.page);
        const page = record.manifest.pages[args.page - 1]!;
        const assets = record.pages[args.page - 1]!;
        const image = await uploadBase64(assets.view);
        const area = textArea(doc);
        showActivity(ctx, doc, { chatId: ctx.author, status: "reading", label: `Reading page ${args.page} of the PDF`, ...(range ? { range: { from: range.from, to: range.to } } : {}) });
        const text = describePage(page, record, area, range);
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
        content: z.string().min(1).describe("The page's content as Markdown with layout attributes. No \\pagebreak."),
      },
      write: true,
      async handler(args, ctx) {
        const { doc, record } = await importOf(ctx, args.document_id);
        const { range } = ranges(record, doc, args.page);
        if (!range) return fail(`Page ${args.page} isn't in the document any more: it has fewer page breaks than the PDF has pages. Read the document and restore the page breaks first.`);
        const blocks = parseMarkdown(args.content).filter((node) => node.type.name !== "page_break");
        if (!blocks.length) return fail("The content parsed to nothing.");
        if (lockedBetween(doc.doc, range.from, range.to)) return fail("Part of this page is locked by the user, so it can't be replaced.");
        await ctx.beforeWrite?.(doc);
        const tr = new Transform(doc.doc);
        tr.replaceWith(range.from, range.to, blocks);
        if (!tr.docChanged) return fail("The page already has this content.");
        // A conversion isn't an edit to review: it is applied as it is, and can be undone from the version history.
        doc.applyTransform(tr, { kind: "system", label: "pdf-import" }, { hunks: mapHunks(doc.hunks, tr.mapping) });
        const written = pageRanges(doc.doc)[args.page - 1]!;
        showActivity(ctx, doc, { chatId: ctx.author, status: "editing", label: `Converted page ${args.page}`, range: { from: written.from, to: written.to } });
        doc.sendCommand({ kind: "scroll_to", from: written.from, to: Math.min(written.to, written.from + 1), version: doc.version });
        const meta = doc.meta.pdfImport;
        if (meta) doc.setPdfImport({ converted: [...meta.converted, args.page] });
        ctx.onChange?.({ documentId: doc.id, title: doc.meta.title, tool: "write_pdf_page", added: wordsIn(blocks), removed: 0 });
        const taken = await pagesTaken(doc, written);
        const left = pagesLeft(doc.doc, record.manifest.pageCount);
        const fit = !taken
          ? "The editor hasn't measured it yet; compare_pdf_page will wait for it."
          : taken.count === 1
            ? `It fits on one page (page ${taken.first + 1} of the document).`
            : `It runs over ${taken.count} pages of the document (pages ${taken.first + 1}-${taken.last + 1}): it must fit on one. Tighten its spacing or check for something too tall.`;
        return ok(`Wrote page ${args.page}: ${blocks.length} block${blocks.length === 1 ? "" : "s"}. ${fit}${left.length ? ` Pages still to convert: ${compactPages(left)}.` : " Every page is converted now; finish with finish_pdf_import once they all match."} Next: compare_pdf_page with page ${args.page}, before going on.`);
      },
    }),

    defineTool({
      name: "compare_pdf_page",
      title: "Compare PDF page",
      description:
        "Compare a converted page with the original: shows the original page and the page as the editor lays it out (the way it would print), and lists how far each line sits from its place in the original, in points. Use it after write_pdf_page and fix what differs. Needs the document open in the editor.",
      shape: { document_id: documentId, page: z.number().int().min(1).describe("Page number in the PDF (1-based).") },
      write: false,
      async handler(args, ctx) {
        const { doc, record } = await importOf(ctx, args.document_id);
        const { range } = ranges(record, doc, args.page);
        if (!range) return fail(`Page ${args.page} isn't in the document any more.`);
        const taken = await pagesTaken(doc, range);
        if (!taken) return fail("The editor hasn't laid the page out yet: it may be busy, or the document isn't open. Try again in a moment; if it keeps failing, ask the user to open the document in Inline.");
        const wanted = taken.count > 1 ? [taken.first, taken.first + 1] : [taken.first];
        showActivity(ctx, doc, { chatId: ctx.author, status: "reading", label: `Comparing page ${args.page}`, range: { from: range.from, to: range.to } });
        let rendered;
        try {
          rendered = await requestPageRenders(doc, wanted, { scale: 2 });
        } catch (error) {
          if (error instanceof RenderUnavailableError) return fail(error.message);
          throw error;
        }
        if (!rendered.length) return fail("The editor couldn't picture the page.");
        const original = await uploadBase64(record.pages[args.page - 1]!.view);
        const analysis = record.manifest.pages[args.page - 1]!;
        const report = compareLines(analysis.lines, rendered[0]!.lines ?? []);
        const placed = report.filter((row) => row.rendered !== null);
        const offsets = placed.map((row) => row.rendered! - row.original);
        const worst = placed.reduce<(typeof placed)[number] | null>((acc, row) => (!acc || Math.abs(row.rendered! - row.original) > Math.abs(acc.rendered! - acc.original) ? row : acc), null);
        const lines = report.map((row) =>
          row.rendered === null ? `  ${f(row.original).padStart(6)}  missing  "${row.text}"` : `  ${f(row.original).padStart(6)} ${f(row.rendered).padStart(7)}  ${(row.rendered - row.original >= 0 ? "+" : "") + f(row.rendered - row.original)}${row.dx !== null && Math.abs(row.dx) > 3 ? ` (x ${row.dx > 0 ? "+" : ""}${f(row.dx)})` : ""}  "${row.text}"`,
        );
        const summary = placed.length
          ? `Lines found: ${placed.length} of ${report.length}. Offsets from the original: ${f(Math.min(...offsets))} to ${f(Math.max(...offsets))} pt${worst ? ` (largest at "${worst.text}")` : ""}. Within ±3 pt is a match; a steady drift means spacing above that point is off.`
          : "No lines could be matched by their words (a page of equations or pictures): compare the pictures.";
        const images = [...(original ? [{ data: original, mimeType: "image/png" }] : []), ...rendered.map((page) => ({ data: Buffer.from(page.png).toString("base64"), mimeType: "image/png" }))];
        return {
          text: [
            `Page ${args.page}: the first picture is the original, ${rendered.length === 1 ? "the second is your page" : "the next two are your page and the one it runs onto"} (page ${taken.first + 1} of the document)${taken.count > 1 ? `. It takes ${taken.count} pages: it must fit on one.` : "."}`,
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
        "Line a converted page up with the original: measures where each block's first line sits in the editor against the PDF and sets the space above and below blocks so every line lands at its original height, repeating until it matches. Run it after write_pdf_page (it changes only spacing), then check with compare_pdf_page. Needs the document open in the editor.",
      shape: { document_id: documentId, page: z.number().int().min(1).describe("Page number in the PDF (1-based).") },
      write: true,
      async handler(args, ctx) {
        const { doc, record } = await importOf(ctx, args.document_id);
        const analysis = record.manifest.pages[args.page - 1];
        if (!analysis) return fail(`The PDF has pages 1 to ${record.manifest.pageCount}.`);
        await ctx.beforeWrite?.(doc);
        showActivity(ctx, doc, { chatId: ctx.author, status: "editing", label: `Lining up page ${args.page}` });
        // Measure, set the spacing, and measure again: a few rounds settle what one can't (lines that wrap differently).
        const MEASUREMENTS = 5;
        let measured = 0;
        let last: ReturnType<typeof planAlignment> | null = null;
        let pagesUsed = 1;
        while (measured < MEASUREMENTS) {
          const { range } = ranges(record, doc, args.page);
          if (!range) return fail(`Page ${args.page} isn't in the document any more.`);
          const taken = await pagesTaken(doc, range);
          if (!taken) return fail("The editor hasn't laid the page out yet: it may be busy, or the document isn't open. Try again in a moment.");
          pagesUsed = taken.count;
          let rendered;
          try {
            rendered = await requestPageRenders(doc, [taken.first], { scale: 1 });
          } catch (error) {
            if (error instanceof RenderUnavailableError) return fail(error.message);
            throw error;
          }
          const page = rendered[0];
          if (!page?.blocks?.length || !page.lines) return fail("The editor didn't report where the page's blocks are.");
          // Only the blocks of this original page (a page that overflows starts the next one's blocks on the same sheet).
          const ids = new Set(range.nodes.map((node) => String(node.attrs.id ?? "")));
          const blocks = page.blocks.filter((block) => ids.has(block.id));
          const spacing = (id: string): BlockSpacing | null => {
            const node = range.nodes.find((item) => item.attrs.id === id);
            if (!node) return null;
            // Paragraphs, headings and displayed equations take spacing of their own.
            const spaced = TEXTBLOCK_TYPES.has(node.type.name) || (node.type.name === "code_block" && node.attrs.language === MATH_LANGUAGE);
            return { spaceBefore: node.attrs.spaceBefore ?? null, spaceAfter: node.attrs.spaceAfter ?? null, canBefore: spaced, canAfter: spaced };
          };
          last = planAlignment(analysis.lines, page.lines, blocks, spacing);
          measured += 1;
          if (!last.changes.size || measured === MEASUREMENTS) break;
          const tr = new Transform(doc.doc);
          doc.doc.forEach((node, pos) => {
            const patch = last!.changes.get(String(node.attrs.id ?? ""));
            if (patch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch });
          });
          if (!tr.docChanged) break;
          doc.applyTransform(tr, { kind: "system", label: "pdf-align" }, { hunks: mapHunks(doc.hunks, tr.mapping) });
        }
        if (!last) return fail("Nothing on the page could be matched with the original.");
        const offsets = last.offsets.map((row) => row.offset);
        const worst = offsets.length ? Math.max(...offsets.map(Math.abs)) : 0;
        return ok(
          [
            `Lined up page ${args.page} (${measured} measurement${measured === 1 ? "" : "s"}). ${offsets.length ? `Its blocks' first lines are now ${f(Math.min(...offsets))} to ${f(Math.max(...offsets))} pt from where they are in the original${worst <= 3 ? ": a match" : ""}.` : "No line could be matched by its words."}`,
            pagesUsed > 1 ? `It still takes ${pagesUsed} pages: shorten its spacing or content so it fits on one, then align again.` : "",
            "Check it with compare_pdf_page.",
          ]
            .filter(Boolean)
            .join(" "),
        );
      },
    }),

    defineTool({
      name: "finish_pdf_import",
      title: "Finish PDF import",
      description: "Mark an imported PDF's conversion as finished, once every page is written and matches the original. Reports pages that are still pictures.",
      shape: { document_id: documentId },
      write: true,
      async handler(args, ctx) {
        const { doc, record } = await importOf(ctx, args.document_id);
        const left = pagesLeft(doc.doc, record.manifest.pageCount);
        if (left.length) return fail(`Page${left.length === 1 ? "" : "s"} ${compactPages(left)} ${left.length === 1 ? "is" : "are"} still the original picture. Convert ${left.length === 1 ? "it" : "them"} with read_pdf_page and write_pdf_page first.`);
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
function describePage(page: PdfPageAnalysis, record: PdfImportRecord, area: ReturnType<typeof textArea>, range: PageRange | undefined) {
  const lines = page.lines.map(describeLine);
  const out = [
    `Page ${page.page} of ${record.manifest.pageCount} (${f(page.width)} × ${f(page.height)} pt), in the document: ${pageStatus(range)}.`,
    `The document's text area starts ${f(area.left)} pt from the left and ${f(area.top)} pt from the top, and is ${f(area.width)} pt wide. Positions are points from the page's top left; y is a line's baseline, x its left edge. ⇥ is a wide gap (a tab stop or a column).`,
    page.scanned ? "This page is a scan with no text layer: read everything from the picture." : "",
    page.ink.count ? `Annotations were removed from this page${page.ink.box ? ` (around ${pointsBox(page.ink.box)})` : ""}; don't look for them.` : "",
    "",
    lines.length ? "Text lines (y, x, size, font: text):" : "No text lines.",
    ...lines,
  ];
  if (page.rules.length) {
    out.push("", "Rules and frames:");
    for (const rule of page.rules) {
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
  if (page.links.length) {
    out.push("", "Links:");
    for (const link of page.links) out.push(`- "${link.text ?? ""}" → ${link.url ?? `page ${link.page}`}`);
  }
  return out.filter((line, index, all) => line !== "" || (index > 0 && all[index - 1] !== "")).join("\n");
}

import { parseCanvas, visibleText, type CanvasOutput } from "@/lib/doc/canvas";
import type { PdfDocumentModel, PdfItem, RGB, StandardFont } from "@/lib/pdf/pdfWriter";

/**
 * A canvas exported to PDF. The pages follow the canvas: section titles, the
 * text a person can edit, layout reduced to its words, and notebook cells with
 * their source and the last output.
 */

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const INK: RGB = [0.12, 0.12, 0.11];
const MUTED: RGB = [0.35, 0.34, 0.32];
const RULE: RGB = [0.85, 0.84, 0.8];
const CODE_FILL: RGB = [0.96, 0.95, 0.93];

export function canvasPdfModel(html: string, title: string, outputs: Record<string, CanvasOutput> = {}): PdfDocumentModel {
  const model = parseCanvas(html);
  const pages: PdfItem[][] = [[]];
  let y = MARGIN;

  const page = () => pages[pages.length - 1]!;
  const next = () => {
    pages.push([]);
    y = MARGIN;
  };
  const ensure = (height: number) => {
    if (y + height > PAGE_H - MARGIN) next();
  };
  const text = (value: string, x: number, size: number, font: StandardFont, color: RGB, width: number) => {
    const lines = wrap(value, width, size, font === "Courier" ? 0.6 : 0.5);
    for (const line of lines) {
      ensure(size + 4);
      page().push({ kind: "text", x, y, text: line, font, size, color });
      y += size + 4;
    }
  };

  ensure(22);
  page().push({ kind: "text", x: MARGIN, y, text: title || "Canvas", font: "Helvetica-Bold", size: 18, color: INK });
  y += 28;

  for (const section of model.sections) {
    ensure(36);
    page().push({ kind: "line", x1: MARGIN, y1: y, x2: PAGE_W - MARGIN, y2: y, width: 0.6, color: RULE });
    y += 16;
    text(section.title || "Section", MARGIN, 14, "Helvetica-Bold", INK, PAGE_W - MARGIN * 2);
    y += 4;
    for (const block of section.blocks) {
      if (block.kind === "heading") text(block.text, MARGIN, 12, "Helvetica-Bold", INK, PAGE_W - MARGIN * 2);
      else if (block.kind === "text") text(block.text, MARGIN, 11, "Helvetica", INK, PAGE_W - MARGIN * 2);
      else if (block.kind === "layout") text(visibleText(block.html), MARGIN, 11, "Helvetica", INK, PAGE_W - MARGIN * 2);
      else {
        const label = block.kind === "cell" ? block.language : "code";
        const body = block.kind === "cell" ? block.source : block.source;
        const output = block.kind === "cell" ? outputs[block.id] : undefined;
        text(label, MARGIN, 9, "Helvetica", MUTED, PAGE_W - MARGIN * 2);
        const lines = wrap(body || "", PAGE_W - MARGIN * 2 - 16, 9, 0.6);
        const boxHeight = Math.max(1, lines.length) * 13 + 10;
        ensure(boxHeight);
        page().push({ kind: "rect", x: MARGIN, y: y - 2, width: PAGE_W - MARGIN * 2, height: boxHeight, fill: CODE_FILL });
        for (const line of lines.length ? lines : [""]) {
          page().push({ kind: "text", x: MARGIN + 8, y: y + 9, text: line, font: "Courier", size: 9, color: INK });
          y += 13;
        }
        y += 10;
        if (output && (output.stdout || output.stderr || output.error)) {
          text(output.error || output.stderr || output.stdout, MARGIN, 9, "Courier", MUTED, PAGE_W - MARGIN * 2);
        }
      }
    }
    y += 8;
  }

  return { title: title || "Canvas", pages: pages.map((items) => ({ width: PAGE_W, height: PAGE_H, items })) };
}

function wrap(value: string, width: number, size: number, factor: number) {
  const max = Math.max(8, Math.floor(width / (size * factor)));
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let rest = paragraph;
    while (rest.length > max) {
      let cut = rest.lastIndexOf(" ", max);
      if (cut < 8) cut = max;
      lines.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    lines.push(rest);
  }
  return lines;
}

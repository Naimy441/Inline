// Turns the rendered paginated document into a PDF page model. It reads the
// layout the browser already computed (paper boxes, line boxes per word,
// header/footer chrome), so page breaks, margins and wrapping in the PDF match
// what the editor shows.

import type { PdfDocumentModel, PdfItem, PdfPage, RGB, StandardFont } from "@/lib/pdf/pdfWriter";

export type Box = { left: number; top: number; width: number; height: number };

export type SnapshotStyle = Pick<
  CSSStyleDeclaration,
  | "display"
  | "visibility"
  | "color"
  | "backgroundColor"
  | "fontFamily"
  | "fontSize"
  | "fontWeight"
  | "fontStyle"
  | "textDecorationLine"
  | "textTransform"
  | "listStyleType"
  | "lineHeight"
  | "borderTopWidth"
  | "borderTopStyle"
  | "borderTopColor"
  | "borderRightWidth"
  | "borderRightStyle"
  | "borderRightColor"
  | "borderBottomWidth"
  | "borderBottomStyle"
  | "borderBottomColor"
  | "borderLeftWidth"
  | "borderLeftStyle"
  | "borderLeftColor"
> & { getPropertyValue(name: string): string };

/** Layout reads, injectable so the walk can be tested without a layout engine. */
export type PageMeasurer = {
  /** Border box in viewport pixels (after zoom transforms). */
  box(el: Element): Box;
  /** Line fragments of an inline element in viewport pixels. */
  boxes(el: Element): Box[];
  /** Line fragments of node.data.slice(start, end) in viewport pixels. */
  textBoxes(node: Text, start: number, end: number): Box[];
  /** Untransformed layout size in CSS pixels. */
  layoutSize(el: HTMLElement): { width: number; height: number };
  style(el: Element): SnapshotStyle;
  /** Advance width in CSS pixels of text set in the given style. */
  textWidth(text: string, style: SnapshotStyle): number;
  image(img: HTMLImageElement, width: number, height: number): { jpeg: Uint8Array; width: number; height: number } | null;
};

const PX_TO_PT = 0.75;

/**
 * Where the pieces of the paginated editor live in the DOM (see
 * components/workspace/PageCanvas.tsx and the editor decorations).
 */
export type SnapshotLayout = {
  /** One element per printed page, in order; their boxes define the PDF pages. */
  pages: string;
  /** The element whose text color is the theme's default ink (printed black). */
  ink: string;
  /** UI inside the page area that is not part of what gets printed. */
  skip: string;
  /** Tints that are editor state (review, comments, find), not document formatting. */
  noBackground: string;
};

export const EDITOR_LAYOUT: SnapshotLayout = {
  pages: ".sheet",
  ink: ".doc-content",
  skip: [
    ".page-gap",
    ".page-break",
    ".review-delete",
    ".review-layer",
    ".agent-caret",
    ".agent-caret-flag",
    ".np-mark",
    ".ProseMirror-gapcursor",
    ".ProseMirror-separator",
    ".ProseMirror-trailingBreak",
    ".column-resize-handle",
    "script",
    "style",
    "template",
  ].join(","),
  noBackground: [".sheet", ".page-content", ".doc-content", ".review-insert", ".review-format", ".comment-hl", ".find-match", ".agent-range", ".np-space"].join(","),
};

type Placed = { page: number; x: number; y: number; width: number; height: number };
type Inherited = { underline: boolean; strike: boolean };
type Marker = { text: string; right: number; style: SnapshotStyle };

export function snapshotPages(
  root: HTMLElement,
  title: string,
  measure: PageMeasurer = domMeasurer(),
  layout: SnapshotLayout = EDITOR_LAYOUT,
  /** Read only the first few pages (thumbnails): later blocks are skipped without being walked. */
  maxPages = Infinity,
): PdfDocumentModel {
  const papers = [...root.querySelectorAll<HTMLElement>(layout.pages)];
  if (!papers.length) throw new Error("No pages to export.");

  const paperBoxes = papers.map((paper) => measure.box(paper));
  const size = measure.layoutSize(papers[0]);
  const scale = size.width ? paperBoxes[0].width / size.width : 1;
  const pages: PdfPage[] = papers.map((paper) => {
    const { width, height } = measure.layoutSize(paper);
    return { width: width * PX_TO_PT, height: height * PX_TO_PT, items: [] };
  });

  const editor = root.querySelector(layout.ink);
  const ink = editor ? parseColor(measure.style(editor).color) : null;

  const pageAt = (centerY: number) => {
    let best = 0;
    let bestDistance = Infinity;
    paperBoxes.forEach((paper, index) => {
      const distance = centerY < paper.top ? paper.top - centerY : centerY > paper.top + paper.height ? centerY - paper.top - paper.height : 0;
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });
    return best;
  };

  const place = (box: Box): Placed => {
    const page = pageAt(box.top + box.height / 2);
    const paper = paperBoxes[page];
    return {
      page,
      x: ((box.left - paper.left) / scale) * PX_TO_PT,
      y: ((box.top - paper.top) / scale) * PX_TO_PT,
      width: (box.width / scale) * PX_TO_PT,
      height: (box.height / scale) * PX_TO_PT,
    };
  };

  const add = (page: number, item: PdfItem) => {
    if (page < maxPages) pages[page].items.push(item);
  };
  const lastPaper = paperBoxes[Math.min(paperBoxes.length, maxPages) - 1]!;
  const limit = maxPages < paperBoxes.length ? lastPaper.top + lastPaper.height : Infinity;

  const textColor = (style: SnapshotStyle): RGB | null => {
    const parsed = parseColor(style.color);
    if (!parsed || parsed.alpha === 0) return null;
    // The default ink follows the app theme; print it black like the light theme.
    if (ink && sameColor(parsed, ink)) return [0, 0, 0];
    return parsed.rgb;
  };

  let marker: Marker | null = null;

  const emitText = (text: string, box: Box, style: SnapshotStyle) => {
    const color = textColor(style);
    if (!color || (!box.width && !box.height)) return;
    const at = place(box);
    const sizePt = cssPx(style.fontSize) * PX_TO_PT;
    const font = standardFont(style);
    const baseline = at.y + at.height * baselineRatio(font);
    if (marker) {
      const markerColor = textColor(marker.style) ?? color;
      const width = measure.textWidth(marker.text, marker.style) * PX_TO_PT;
      const right = ((marker.right - paperBoxes[at.page].left) / scale) * PX_TO_PT;
      add(at.page, {
        kind: "text",
        x: right - width,
        y: baseline,
        text: marker.text,
        font: standardFont(marker.style),
        size: cssPx(marker.style.fontSize) * PX_TO_PT,
        color: markerColor,
      });
      marker = null;
    }
    add(at.page, { kind: "text", x: at.x, y: baseline, text: transform(text, style.textTransform), font, size: sizePt, color });
  };

  /** Underline and strike-through run across a whole line of the node, spaces included. */
  const decorate = (box: Box, style: SnapshotStyle, decoration: Inherited) => {
    const color = textColor(style);
    if (!color || !box.width || (!decoration.underline && !decoration.strike)) return;
    const at = place(box);
    const sizePt = cssPx(style.fontSize) * PX_TO_PT;
    const baseline = at.y + at.height * baselineRatio(standardFont(style));
    const thickness = Math.max(0.5, sizePt * 0.06);
    const line = (y: number) => add(at.page, { kind: "line", x1: at.x, y1: y, x2: at.x + at.width, y2: y, width: thickness, color });
    if (decoration.underline) line(baseline + sizePt * 0.12);
    if (decoration.strike) line(baseline - sizePt * 0.28);
  };

  const walkText = (node: Text, style: SnapshotStyle, decoration: Inherited) => {
    const data = node.data;
    for (const match of data.matchAll(/\S+/g)) {
      const start = match.index!;
      const end = start + match[0].length;
      const boxes = measure.textBoxes(node, start, end).filter((box) => box.width > 0 || box.height > 0);
      if (boxes.length <= 1) {
        if (boxes[0]) emitText(match[0], boxes[0], style);
        continue;
      }
      // The word wraps across lines (overflow-wrap: anywhere), so place each piece.
      let pieceStart = start;
      let pieceBox = null as Box | null;
      for (let i = start; i < end; i += 1) {
        const charBox = measure.textBoxes(node, i, i + 1)[0];
        if (!charBox) continue;
        if (pieceBox && Math.abs(charBox.top - pieceBox.top) > 1) {
          emitText(data.slice(pieceStart, i), pieceBox, style);
          pieceStart = i;
          pieceBox = null;
        }
        pieceBox = pieceBox
          ? { ...pieceBox, width: charBox.left + charBox.width - pieceBox.left, height: Math.max(pieceBox.height, charBox.height) }
          : charBox;
      }
      if (pieceBox) emitText(data.slice(pieceStart, end), pieceBox, style);
    }
    if (decoration.underline || decoration.strike) {
      const first = data.search(/\S/);
      const last = data.length - (data.match(/\s*$/)?.[0].length ?? 0);
      if (first >= 0) for (const box of measure.textBoxes(node, first, last)) decorate(box, style, decoration);
    }
  };

  const paintBox = (el: HTMLElement, style: SnapshotStyle) => {
    if (!el.matches(layout.noBackground)) {
      const fill = parseColor(el.style?.getPropertyValue("--doc-hl") || style.backgroundColor);
      if (fill && fill.alpha > 0) {
        for (const box of measure.boxes(el)) {
          if (!box.width || !box.height) continue;
          const at = place(box);
          add(at.page, { kind: "rect", x: at.x, y: at.y, width: at.width, height: at.height, fill: blend(fill) });
        }
      }
    }
    const sides = [
      ["Top", style.borderTopWidth, style.borderTopStyle, style.borderTopColor],
      ["Right", style.borderRightWidth, style.borderRightStyle, style.borderRightColor],
      ["Bottom", style.borderBottomWidth, style.borderBottomStyle, style.borderBottomColor],
      ["Left", style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor],
    ] as const;
    if (sides.every(([, width, kind]) => !cssPx(width) || kind === "none" || kind === "hidden")) return;
    const at = place(measure.box(el));
    for (const [side, widthValue, kind, colorValue] of sides) {
      const width = cssPx(widthValue) * PX_TO_PT;
      const color = parseColor(colorValue);
      if (!width || kind === "none" || kind === "hidden" || !color || color.alpha === 0) continue;
      // Collapsed table borders are shared by neighboring cells, so center them on the edge.
      const half = el.tagName === "TD" || el.tagName === "TH" ? 0 : width / 2;
      const line =
        side === "Top" ? [at.x, at.y + half, at.x + at.width, at.y + half]
        : side === "Bottom" ? [at.x, at.y + at.height - half, at.x + at.width, at.y + at.height - half]
        : side === "Left" ? [at.x + half, at.y, at.x + half, at.y + at.height]
        : [at.x + at.width - half, at.y, at.x + at.width - half, at.y + at.height];
      add(at.page, { kind: "line", x1: line[0], y1: line[1], x2: line[2], y2: line[3], width, color: blend(color) });
    }
  };

  /** Checklist boxes are drawn with CSS (::before), so draw them here: 13px, 22px left of the item. */
  const checkbox = (li: HTMLElement, style: SnapshotStyle) => {
    const box = measure.box(li);
    const em = cssPx(style.fontSize) * scale;
    const side = 13 * scale;
    const at = place({ left: box.left - 22 * scale, top: box.top + 0.2 * em, width: side, height: side });
    const checked = li.getAttribute("data-checked") === "true";
    const color: RGB = checked ? [0.102, 0.451, 0.91] : [0.502, 0.525, 0.545];
    if (checked) add(at.page, { kind: "rect", x: at.x, y: at.y, width: at.width, height: at.height, fill: color });
    const edges: Array<[number, number, number, number]> = [
      [at.x, at.y, at.x + at.width, at.y],
      [at.x + at.width, at.y, at.x + at.width, at.y + at.height],
      [at.x + at.width, at.y + at.height, at.x, at.y + at.height],
      [at.x, at.y + at.height, at.x, at.y],
    ];
    for (const [x1, y1, x2, y2] of edges) add(at.page, { kind: "line", x1, y1, x2, y2, width: 1.1, color });
    if (checked) {
      const w = at.width;
      const tick = (x1: number, y1: number, x2: number, y2: number) =>
        add(at.page, { kind: "line", x1: at.x + x1 * w, y1: at.y + y1 * w, x2: at.x + x2 * w, y2: at.y + y2 * w, width: 1.3, color: [1, 1, 1] });
      tick(0.22, 0.52, 0.42, 0.72);
      tick(0.42, 0.72, 0.8, 0.28);
    }
  };

  const walk = (el: HTMLElement, decoration: Inherited) => {
    if (el.matches(layout.skip)) return;
    // Past the last page asked for: the rest of the document is below it.
    if (limit !== Infinity && el.parentElement?.matches(layout.ink) && measure.box(el).top > limit) return;
    const style = measure.style(el);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return;

    paintBox(el, style);

    const lines = style.textDecorationLine || "";
    const next: Inherited = {
      underline: decoration.underline || lines.includes("underline"),
      strike: decoration.strike || lines.includes("line-through"),
    };

    if (el.tagName === "IMG") {
      const img = el as HTMLImageElement;
      const box = measure.box(img);
      const layout = measure.layoutSize(img);
      const data = box.width && box.height ? measure.image(img, layout.width, layout.height) : null;
      if (data) {
        const at = place(box);
        add(at.page, { kind: "image", x: at.x, y: at.y, width: at.width, height: at.height, jpeg: data.jpeg, pixelWidth: data.width, pixelHeight: data.height });
      }
      return;
    }

    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      // The header/footer field while it is being edited: its text is not in the DOM tree.
      const value = (el as HTMLTextAreaElement).value;
      const box = measure.box(el);
      const lineHeight = cssPx(style.lineHeight) || cssPx(style.fontSize) * 1.35;
      value.split("\n").forEach((line, index) => {
        const text = line.trim();
        if (!text) return;
        const indent = line.length - line.trimStart().length;
        const left = box.left + measure.textWidth(line.slice(0, indent), style) * scale;
        const lineBox = { left, top: box.top + index * lineHeight * scale, width: measure.textWidth(text, style) * scale, height: lineHeight * scale };
        emitText(text, lineBox, style);
        decorate(lineBox, style, next);
      });
      return;
    }

    if (el.tagName === "A") {
      const href = el.getAttribute("href");
      if (href && /^(https?:|mailto:)/i.test(href)) {
        for (const box of measure.boxes(el)) {
          if (!box.width || !box.height) continue;
          const at = place(box);
          add(at.page, { kind: "link", x: at.x, y: at.y, width: at.width, height: at.height, uri: href });
        }
      }
    }

    if (el.tagName === "LI" && el.classList.contains("task-item")) checkbox(el, style);

    if (el.tagName === "LI") {
      const text = markerText(el, style);
      const box = measure.box(el);
      const em = cssPx(style.fontSize) * scale;
      marker = text ? { text, right: box.left - 0.3 * em, style } : null;
    }

    for (const child of el.childNodes) {
      if (child.nodeType === 3) walkText(child as Text, style, next);
      else if (child.nodeType === 1) walk(child as HTMLElement, next);
    }

    if (el.tagName === "LI") marker = null;
  };

  for (const child of root.children) walk(child as HTMLElement, { underline: false, strike: false });

  return { title: title.trim() || "Untitled document", pages: pages.slice(0, maxPages) };
}

function markerText(li: HTMLElement, style: SnapshotStyle) {
  const list = li.parentElement;
  if (li.classList.contains("task-item")) return "";
  const type = style.listStyleType || (list?.tagName === "OL" ? "decimal" : "disc");
  if (type === "none") return "";
  if (type === "disc" || type === "square") return "\u2022";
  if (type === "circle") return "o";
  let index = 0;
  const start = Number(list?.getAttribute("start") ?? 1);
  for (const sibling of list?.children ?? []) {
    if (sibling.tagName !== "LI") continue;
    if (sibling === li) break;
    index += 1;
  }
  const n = (Number.isFinite(start) ? start : 1) + index;
  if (type === "lower-alpha" || type === "lower-latin") return `${alpha(n)}.`;
  if (type === "upper-alpha" || type === "upper-latin") return `${alpha(n).toUpperCase()}.`;
  if (type === "lower-roman") return `${roman(n).toLowerCase()}.`;
  if (type === "upper-roman") return `${roman(n)}.`;
  return `${n}.`;
}

function alpha(n: number) {
  let out = "";
  for (let value = n; value > 0; value = Math.floor((value - 1) / 26)) out = String.fromCharCode(97 + ((value - 1) % 26)) + out;
  return out || String(n);
}

function roman(n: number) {
  const table: Array<[number, string]> = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "";
  let value = n;
  for (const [amount, numeral] of table) {
    while (value >= amount) {
      out += numeral;
      value -= amount;
    }
  }
  return out || String(n);
}

function transform(text: string, mode: string) {
  if (mode === "uppercase") return text.toUpperCase();
  if (mode === "lowercase") return text.toLowerCase();
  if (mode === "capitalize") return text.replace(/(^|\s)(\S)/g, (_, space: string, char: string) => space + char.toUpperCase());
  return text;
}

function cssPx(value: string | undefined) {
  const parsed = parseFloat(value ?? "");
  if (!Number.isFinite(parsed)) return 0;
  if (value?.endsWith("pt")) return parsed / PX_TO_PT;
  return parsed;
}

const SERIF = /(times|georgia|garamond|cambria|palatino|merriweather|lora|playfair|baskerville|book antiqua|libre|crimson|^serif$)/i;
const MONO = /(mono|courier|consolas|menlo|monaco|code)/i;

export function standardFont(style: Pick<SnapshotStyle, "fontFamily" | "fontWeight" | "fontStyle">): StandardFont {
  const family = (style.fontFamily || "").split(",")[0].trim().replace(/^["']|["']$/g, "");
  const bold = style.fontWeight === "bold" || Number(style.fontWeight) >= 600;
  const italic = style.fontStyle === "italic" || style.fontStyle.startsWith("oblique");
  if (MONO.test(family)) return bold ? (italic ? "Courier-BoldOblique" : "Courier-Bold") : italic ? "Courier-Oblique" : "Courier";
  if (SERIF.test(family)) return bold ? (italic ? "Times-BoldItalic" : "Times-Bold") : italic ? "Times-Italic" : "Times-Roman";
  return bold ? (italic ? "Helvetica-BoldOblique" : "Helvetica-Bold") : italic ? "Helvetica-Oblique" : "Helvetica";
}

/** Where the baseline sits within a text line box, from typical ascent/descent metrics. */
function baselineRatio(font: StandardFont) {
  if (font.startsWith("Courier")) return 0.735;
  if (font.startsWith("Times")) return 0.805;
  return 0.81;
}

type ParsedColor = { rgb: RGB; alpha: number };

export function parseColor(value: string | undefined): ParsedColor | null {
  if (!value) return null;
  const text = value.trim().toLowerCase();
  if (text === "transparent") return { rgb: [0, 0, 0], alpha: 0 };
  const hex = text.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    const digits = hex[1].length <= 4 ? [...hex[1]].map((d) => d + d).join("") : hex[1];
    const channels = digits.match(/../g)!.map((pair) => parseInt(pair, 16) / 255);
    return { rgb: [channels[0], channels[1], channels[2]], alpha: channels[3] ?? 1 };
  }
  const rgb = text.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map((part) => (part.endsWith("%") ? (parseFloat(part) / 100) * 255 : parseFloat(part)));
    if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
    const alphaPart = rgb[1].split(/[\s,/]+/).filter(Boolean)[3];
    const alpha = alphaPart === undefined ? 1 : alphaPart.endsWith("%") ? parseFloat(alphaPart) / 100 : parseFloat(alphaPart);
    return { rgb: [parts[0] / 255, parts[1] / 255, parts[2] / 255], alpha };
  }
  const srgb = text.match(/^color\(srgb\s+([^)]+)\)$/);
  if (srgb) {
    const [channels, alphaPart] = srgb[1].split("/");
    const parts = channels.trim().split(/\s+/).map(parseFloat);
    if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return null;
    return { rgb: [parts[0], parts[1], parts[2]], alpha: alphaPart ? parseFloat(alphaPart) : 1 };
  }
  return null;
}

function sameColor(a: ParsedColor, b: ParsedColor) {
  return a.rgb.every((channel, index) => Math.abs(channel - b.rgb[index]) < 0.01);
}

/** Composites a translucent fill over white paper, since the writer has no transparency. */
function blend(color: ParsedColor): RGB {
  const alpha = Math.min(1, Math.max(0, color.alpha));
  return color.rgb.map((channel) => channel * alpha + (1 - alpha)) as RGB;
}

export function domMeasurer(): PageMeasurer {
  const toBox = (rect: DOMRect | DOMRectReadOnly): Box => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  let canvas: HTMLCanvasElement | null = null;
  const context = () => {
    canvas ??= document.createElement("canvas");
    return canvas.getContext("2d");
  };
  return {
    box: (el) => toBox(el.getBoundingClientRect()),
    boxes: (el) => [...el.getClientRects()].map(toBox),
    textBoxes: (node, start, end) => {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      return [...range.getClientRects()].map(toBox);
    },
    layoutSize: (el) => ({ width: el.offsetWidth, height: el.offsetHeight }),
    style: (el) => window.getComputedStyle(el),
    textWidth: (text, style) => {
      const ctx = context();
      if (!ctx) return text.length * cssPx(style.fontSize) * 0.5;
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return ctx.measureText(text).width;
    },
    image: (img, width, height) => {
      if (!img.complete || !img.naturalWidth) return null;
      // Twice the laid-out size keeps print sharpness without embedding huge originals.
      const w = Math.max(1, Math.round(Math.min(img.naturalWidth, width * 2)));
      const h = Math.max(1, Math.round(Math.min(img.naturalHeight, (w / img.naturalWidth) * img.naturalHeight)));
      const target = document.createElement("canvas");
      target.width = w;
      target.height = h;
      const ctx = target.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      try {
        ctx.drawImage(img, 0, 0, w, h);
        const url = target.toDataURL("image/jpeg", 0.9);
        const binary = atob(url.slice(url.indexOf(",") + 1));
        const jpeg = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) jpeg[i] = binary.charCodeAt(i);
        return { jpeg, width: w, height: h };
      } catch {
        // Cross-origin images taint the canvas and cannot be read back.
        return null;
      }
    },
  };
}

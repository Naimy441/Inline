import type { PdfBox, PdfRule } from "@/lib/pdf/import/types";

/**
 * Sorts a page's drawing operations (pdf.js's operator list) into the page's
 * own content and annotations made on top of it, so the page can be drawn
 * without them (for the document) and they can be drawn alone (to show over
 * the document as they were).
 *
 * Annotations come two ways:
 * - PDF annotations (Ink, Highlight, FreeText, sticky notes…), which pdf.js
 *   brackets with beginAnnotation/endAnnotation; their type says what they are.
 * - Drawing flattened into the page when an app saved or "printed" it (Apple's
 *   Preview and Notes, GoodNotes, Notability, Acrobat's "flatten"). These are
 *   ordinary paths, added after everything the page had: pen strokes (filled
 *   outlines or long polylines, full of curves), translucent highlighter
 *   strokes, or a picture of the ink laid over the page.
 *
 * So a path is taken for ink when it comes after the page's last text and
 * looks hand-drawn. Rules and frames drawn last (a box around a paragraph)
 * are straight and few-sided, and stay content. A drawing that sits in the
 * same place on several pages (a logo) is content too (see `repeatedInk`).
 *
 * The operator codes are passed in (pdf.js's OPS) so this file doesn't load
 * pdf.js itself and runs anywhere.
 */

export type Ops = Record<string, number>;
export type OperatorList = { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> };
export type Matrix = [number, number, number, number, number, number];

export type OpClass = "state" | "content" | "ink";

/** Annotation types that are content, not marks made on the page. */
const CONTENT_ANNOTATIONS = new Set(["Link", "Widget", "Watermark", "Popup", "Screen", "RichMedia", "3D", "PrinterMark", "TrapNet"]);

export type AnnotationInfo = { id: string; subtype: string; contents?: string; rect?: number[] };

export type PaintRecord = {
  index: number;
  kind: "path" | "text" | "image" | "shading";
  box: PdfBox | null;
  /** Path segments drawn, and how many of them are curves. */
  segments: number;
  curves: number;
  /** A path of only horizontal and vertical lines. */
  rectilinear: boolean;
  color: string | null;
  alpha: number;
  stroke: boolean;
  lineWidth: number;
  annotation: string | null;
  /** pdf.js's name of a picture. */
  object?: string;
  pixelWidth?: number;
  pixelHeight?: number;
  ink: boolean;
  inkKind?: string;
  /** Signature for spotting the same drawing on several pages. */
  signature?: string;
};

export type Classification = {
  classes: OpClass[];
  paints: PaintRecord[];
  /** Index of the last text drawn by the page itself (-1 for none). */
  contentEnd: number;
};

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `outer` after `inner`: the matrix for outer(inner(p)), as canvas transform() composes. */
export function compose(outer: readonly number[], inner: readonly number[]): Matrix {
  const [a, b, c, d, e, f] = outer as Matrix;
  const [a2, b2, c2, d2, e2, f2] = inner as Matrix;
  return [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f];
}

export function applyMatrix(m: readonly number[], x: number, y: number): [number, number] {
  return [m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!];
}

/** The box around a rectangle (x0, y0)–(x1, y1) once transformed. */
export function transformBox(m: readonly number[], x0: number, y0: number, x1: number, y1: number): PdfBox {
  const points = [applyMatrix(m, x0, y0), applyMatrix(m, x1, y0), applyMatrix(m, x0, y1), applyMatrix(m, x1, y1)];
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

export function unionBox(a: PdfBox | null, b: PdfBox | null): PdfBox | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

export function overlapArea(a: PdfBox, b: PdfBox) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function chromatic(color: string | null) {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return false;
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
  return Math.max(r!, g!, b!) - Math.min(r!, g!, b!) > 48;
}

function isWhite(color: string | null) {
  return color?.toLowerCase() === "#ffffff";
}

type PathShape = { segments: number; curves: number; rectilinear: boolean; subpaths: number };

/** pdf.js's path data: an opcode (moveTo 0, lineTo 1, curveTo 2, quadraticCurveTo 3, closePath 4) and its points. */
export function pathShape(data: ArrayLike<number> | null | undefined): PathShape {
  const shape: PathShape = { segments: 0, curves: 0, rectilinear: true, subpaths: 0 };
  if (!data) return shape;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  for (let i = 0; i < data.length; ) {
    const op = data[i]!;
    if (op === 0) {
      x = startX = data[i + 1]!;
      y = startY = data[i + 2]!;
      shape.subpaths += 1;
      i += 3;
    } else if (op === 1) {
      const nx = data[i + 1]!;
      const ny = data[i + 2]!;
      if (Math.abs(nx - x) > 0.01 && Math.abs(ny - y) > 0.01) shape.rectilinear = false;
      x = nx;
      y = ny;
      shape.segments += 1;
      i += 3;
    } else if (op === 2) {
      shape.segments += 1;
      shape.curves += 1;
      shape.rectilinear = false;
      x = data[i + 5]!;
      y = data[i + 6]!;
      i += 7;
    } else if (op === 3) {
      shape.segments += 1;
      shape.curves += 1;
      shape.rectilinear = false;
      x = data[i + 3]!;
      y = data[i + 4]!;
      i += 5;
    } else if (op === 4) {
      if (Math.abs(startX - x) > 0.01 && Math.abs(startY - y) > 0.01) shape.rectilinear = false;
      x = startX;
      y = startY;
      i += 1;
    } else {
      // Unknown opcode: stop rather than misread the rest.
      break;
    }
  }
  return shape;
}

/** Whether a path drawn after the page's text looks drawn by hand rather than set by the document. */
export function looksHandDrawn(record: Pick<PaintRecord, "segments" | "curves" | "rectilinear" | "color" | "alpha" | "stroke" | "box" | "lineWidth">) {
  // A translucent mark over the text is a highlighter, straight-edged or not.
  if (record.alpha < 0.95) return true;
  if (record.rectilinear && record.segments <= 6) return false;
  if (record.curves >= 3) return true;
  if (record.segments >= 10 && !record.rectilinear) return true;
  if (chromatic(record.color) && !record.rectilinear && record.segments >= 2) return true;
  return false;
}

const PAINT_OPS = ["stroke", "closeStroke", "fill", "eoFill", "fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke"];
const STROKE_OPS = ["stroke", "closeStroke", "fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke"];
const TEXT_OPS = ["showText", "showSpacedText", "nextLineShowText", "nextLineSetSpacingShowText"];
const IMAGE_OPS = ["paintImageXObject", "paintInlineImageXObject", "paintImageMaskXObject", "paintSolidColorImageMask", "paintImageXObjectRepeat", "paintImageMaskXObjectRepeat", "paintImageMaskXObjectGroup"];

type GraphicsState = { ctm: Matrix; fill: string | null; stroke: string | null; fillAlpha: number; strokeAlpha: number; lineWidth: number; textMode: number };

/**
 * Classify a page's operators. `viewport` maps PDF space to the page as shown
 * (pdf.js's viewport.transform at scale 1); `textBoxes` are where the page's
 * text sits, to tell a picture of ink laid over the text from a figure.
 */
export function classifyOperators(
  list: OperatorList,
  OPS: Ops,
  options: { viewport: readonly number[]; pageWidth: number; pageHeight: number; annotations?: AnnotationInfo[]; textBoxes?: PdfBox[] },
): Classification {
  const names = new Map<number, string>(Object.entries(OPS).map(([name, code]) => [code, name]));
  const paintOps = new Set(PAINT_OPS.map((name) => OPS[name]));
  const strokeOps = new Set(STROKE_OPS.map((name) => OPS[name]));
  const textOps = new Set(TEXT_OPS.map((name) => OPS[name]));
  const imageOps = new Set(IMAGE_OPS.map((name) => OPS[name]));
  const annotationTypes = new Map((options.annotations ?? []).map((item) => [item.id, item.subtype]));
  const count = list.fnArray.length;
  const classes: OpClass[] = new Array(count).fill("state");
  const paints: PaintRecord[] = [];
  const stack: GraphicsState[] = [];
  let state: GraphicsState = { ctm: [...options.viewport] as Matrix, fill: "#000000", stroke: "#000000", fillAlpha: 1, strokeAlpha: 1, lineWidth: 1, textMode: 0 };
  let annotation: string | null = null;
  let annotationStart = -1;
  let contentEnd = -1;

  for (let index = 0; index < count; index += 1) {
    const fn = list.fnArray[index]!;
    const args = list.argsArray[index] as unknown[] | null;
    const name = names.get(fn);
    switch (name) {
      case "save":
        stack.push({ ...state });
        break;
      case "restore":
        state = stack.pop() ?? state;
        break;
      case "transform":
        state.ctm = compose(state.ctm, args as unknown as Matrix);
        break;
      case "paintFormXObjectBegin": {
        stack.push({ ...state });
        const matrix = args?.[0] as Matrix | null;
        if (matrix) state.ctm = compose(state.ctm, matrix);
        break;
      }
      case "paintFormXObjectEnd":
        state = stack.pop() ?? state;
        break;
      case "beginAnnotation": {
        stack.push({ ...state });
        annotation = String(args?.[0] ?? "");
        annotationStart = index;
        const transform = (args?.[2] as Matrix | undefined) ?? IDENTITY;
        const matrix = (args?.[3] as Matrix | undefined) ?? IDENTITY;
        state.ctm = compose(compose([...options.viewport] as Matrix, transform), matrix);
        break;
      }
      case "endAnnotation": {
        state = stack.pop() ?? state;
        const subtype = annotation ? annotationTypes.get(annotation) : undefined;
        const ink = Boolean(subtype && !CONTENT_ANNOTATIONS.has(subtype));
        for (const record of paints) {
          if (record.annotation === annotation && record.index >= annotationStart) {
            record.ink = ink;
            if (ink) record.inkKind = subtype;
          }
        }
        annotation = null;
        break;
      }
      case "setFillRGBColor":
        state.fill = String(args?.[0] ?? "");
        break;
      case "setStrokeRGBColor":
        state.stroke = String(args?.[0] ?? "");
        break;
      case "setFillColorN":
      case "setFillTransparent":
        state.fill = null;
        break;
      case "setStrokeColorN":
      case "setStrokeTransparent":
        state.stroke = null;
        break;
      case "setLineWidth":
        state.lineWidth = Number(args?.[0]) || 0;
        break;
      case "setTextRenderingMode":
        state.textMode = Number(args?.[0]) || 0;
        break;
      case "setGState": {
        for (const entry of (args?.[0] as Array<[string, unknown]>) ?? []) {
          if (entry[0] === "CA") state.strokeAlpha = Number(entry[1]);
          else if (entry[0] === "ca") state.fillAlpha = Number(entry[1]);
          else if (entry[0] === "LW") state.lineWidth = Number(entry[1]);
          else if (entry[0] === "BM" && /multiply|darken/i.test(String(entry[1]))) state.fillAlpha = Math.min(state.fillAlpha, 0.9);
        }
        break;
      }
      case "constructPath": {
        const op = Number(args?.[0]);
        if (!paintOps.has(op)) break;
        const data = (args?.[1] as unknown[] | undefined)?.[0] as ArrayLike<number> | null | undefined;
        const minMax = args?.[2] as ArrayLike<number> | null | undefined;
        const shape = pathShape(data);
        const stroke = strokeOps.has(op);
        const half = stroke ? state.lineWidth / 2 : 0;
        const box = minMax && Number.isFinite(minMax[0]) && minMax[2]! >= minMax[0]! ? transformBox(state.ctm, minMax[0]! - half, minMax[1]! - half, minMax[2]! + half, minMax[3]! + half) : null;
        classes[index] = "content";
        paints.push({
          index,
          kind: "path",
          box,
          ...shape,
          color: stroke && op !== OPS.fill ? state.stroke : state.fill,
          alpha: stroke ? state.strokeAlpha : state.fillAlpha,
          stroke,
          lineWidth: state.lineWidth * Math.hypot(state.ctm[0], state.ctm[1]),
          annotation,
          ink: false,
        });
        break;
      }
      case "shadingFill":
        classes[index] = "content";
        paints.push({ index, kind: "shading", box: null, segments: 0, curves: 0, rectilinear: true, color: null, alpha: state.fillAlpha, stroke: false, lineWidth: 0, annotation, ink: false });
        break;
      default:
        if (textOps.has(fn)) {
          classes[index] = "content";
          // Invisible text (a scan's text layer) is drawn over the picture; it isn't where the page ends.
          if (!annotation && state.textMode !== 3 && state.textMode !== 7) contentEnd = index;
          paints.push({ index, kind: "text", box: null, segments: 0, curves: 0, rectilinear: true, color: state.fill, alpha: state.fillAlpha, stroke: false, lineWidth: 0, annotation, ink: false });
        } else if (imageOps.has(fn)) {
          classes[index] = "content";
          const box = transformBox(state.ctm, 0, 0, 1, 1);
          const first = args?.[0];
          const object = typeof first === "string" ? first : undefined;
          paints.push({
            index,
            kind: "image",
            box,
            segments: 0,
            curves: 0,
            rectilinear: true,
            color: null,
            alpha: state.fillAlpha,
            stroke: false,
            lineWidth: 0,
            annotation,
            ink: false,
            ...(object ? { object } : {}),
            ...(typeof args?.[1] === "number" ? { pixelWidth: args[1] as number, pixelHeight: Number(args[2]) } : {}),
          });
        }
    }
  }

  // A page that is only pictures (a scan): its first big picture is the page, anything after may be ink.
  if (contentEnd < 0) {
    const page = paints.find((record) => record.kind === "image" && !record.annotation && record.box && record.box.width * record.box.height > 0.5 * options.pageWidth * options.pageHeight);
    if (page) contentEnd = page.index;
  }
  const pageArea = options.pageWidth * options.pageHeight;
  for (const record of paints) {
    if (record.annotation || record.index <= contentEnd) continue;
    if (record.kind === "path") {
      if (isWhite(record.color) && record.alpha >= 0.95) continue;
      if (looksHandDrawn(record)) {
        record.ink = true;
        record.inkKind = record.alpha < 0.95 ? "highlighter" : "pen";
      }
    } else if (record.kind === "image" && record.box) {
      // A picture of the ink laid over the page: big, and on top of the text.
      const area = record.box.width * record.box.height;
      const covered = (options.textBoxes ?? []).filter((box) => overlapArea(box, record.box!) > 0.5 * box.width * box.height).length;
      const texts = options.textBoxes?.length ?? 0;
      if (area > 0.4 * pageArea && (texts ? covered >= Math.max(2, texts * 0.3) : area > 0.85 * pageArea)) {
        record.ink = true;
        record.inkKind = "image";
      }
    }
  }
  for (const record of paints) {
    classes[record.index] = record.ink ? "ink" : "content";
    if (record.ink && record.box) record.signature = `${record.kind}:${Math.round(record.box.x)}:${Math.round(record.box.y)}:${Math.round(record.box.width)}:${Math.round(record.box.height)}:${record.segments}:${record.color}`;
  }
  return { classes, paints, contentEnd };
}

/**
 * Signatures of "ink" found in the same place on two or more pages: a logo or
 * a page decoration drawn last, which is the document's, not someone's pen.
 */
export function repeatedInk(pages: Classification[]) {
  const seen = new Map<string, Set<number>>();
  pages.forEach((page, index) => {
    for (const record of page.paints) {
      if (!record.signature) continue;
      const set = seen.get(record.signature) ?? new Set<number>();
      set.add(index);
      seen.set(record.signature, set);
    }
  });
  return new Set([...seen].filter(([, set]) => set.size >= 2).map(([signature]) => signature));
}

/** Take back ink that turned out to be the document's own (see repeatedInk). */
export function restoreContent(page: Classification, signatures: Set<string>) {
  for (const record of page.paints) {
    if (record.signature && signatures.has(record.signature)) {
      record.ink = false;
      delete record.inkKind;
      page.classes[record.index] = "content";
    }
  }
}

/** Draw the page without its annotations. */
export function contentFilter(page: Classification) {
  return (index: number) => page.classes[index] !== "ink";
}

/** Draw only the annotations. */
export function inkFilter(page: Classification) {
  return (index: number) => page.classes[index] !== "content";
}

export function inkBox(page: Classification): PdfBox | null {
  return page.paints.filter((record) => record.ink).reduce<PdfBox | null>((box, record) => unionBox(box, record.box), null);
}

/**
 * Rules and frames: straight lines and boxes the document draws (a rule
 * under a heading or the header, a box around a definition), so they can be
 * rebuilt as paragraph borders. Thin filled rectangles are rules too, as
 * TeX draws them.
 */
export function findRules(page: Classification, pageWidth: number, pageHeight: number): PdfRule[] {
  const rules: PdfRule[] = [];
  for (const record of page.paints) {
    if (record.ink || record.kind !== "path" || !record.box || !record.rectilinear || record.annotation) continue;
    const { box } = record;
    if (box.width > pageWidth * 0.97 && box.height > pageHeight * 0.97) continue;
    if (isWhite(record.color)) continue;
    const color = record.color ?? "#000000";
    // Short thin ones too: fraction bars, overlines, the bar of a root.
    if (box.height <= 2.5 && (box.width >= 12 || (box.width >= 2.5 && box.height <= 1.2))) rules.push({ kind: "hline", box, width: Math.max(0.3, record.stroke ? record.lineWidth : box.height), color });
    else if (box.width <= 2.5 && box.height >= 12) rules.push({ kind: "vline", box, width: Math.max(0.3, record.stroke ? record.lineWidth : box.width), color });
    else if (record.stroke && record.segments >= 3 && record.segments <= 5 && box.width >= 24 && box.height >= 12) rules.push({ kind: "frame", box, width: Math.max(0.3, record.lineWidth), color });
  }
  return mergeFrames(rules);
}

/** Four lines that make a box are one frame. */
function mergeFrames(rules: PdfRule[]): PdfRule[] {
  const near = (a: number, b: number) => Math.abs(a - b) <= 3;
  const used = new Set<PdfRule>();
  const frames: PdfRule[] = [];
  const hlines = rules.filter((rule) => rule.kind === "hline");
  const vlines = rules.filter((rule) => rule.kind === "vline");
  for (const top of hlines) {
    if (used.has(top)) continue;
    for (const bottom of hlines) {
      if (bottom === top || used.has(bottom) || bottom.box.y <= top.box.y + 8) continue;
      if (!near(top.box.x, bottom.box.x) || !near(top.box.width, bottom.box.width)) continue;
      const left = vlines.find((rule) => !used.has(rule) && near(rule.box.x, top.box.x) && near(rule.box.y, top.box.y) && near(rule.box.y + rule.box.height, bottom.box.y + bottom.box.height));
      const right = vlines.find((rule) => rule !== left && !used.has(rule) && near(rule.box.x + rule.box.width, top.box.x + top.box.width) && near(rule.box.y, top.box.y) && near(rule.box.y + rule.box.height, bottom.box.y + bottom.box.height));
      if (!left || !right) continue;
      for (const rule of [top, bottom, left, right]) used.add(rule);
      frames.push({ kind: "frame", box: unionBox(unionBox(top.box, bottom.box), unionBox(left.box, right.box))!, width: top.width, color: top.color });
      break;
    }
  }
  return [...rules.filter((rule) => !used.has(rule)), ...frames].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

/**
 * Drawings made of many lines and curves (a chart, a diagram): regions worth
 * cropping as a picture, since they can't be rebuilt as text.
 */
export function findGraphics(page: Classification, rules: PdfRule[], pageWidth: number, pageHeight: number): PdfBox[] {
  const ruleBoxes = new Set(rules.map((rule) => `${rule.box.x}:${rule.box.y}`));
  const boxes: Array<{ box: PdfBox; weight: number }> = [];
  for (const record of page.paints) {
    if (record.ink || record.annotation || !record.box) continue;
    if (record.kind === "shading") continue;
    if (record.kind !== "path") continue;
    const { box } = record;
    if (box.width > pageWidth * 0.97 && box.height > pageHeight * 0.97) continue;
    if (isWhite(record.color) && record.rectilinear) continue;
    if (ruleBoxes.has(`${box.x}:${box.y}`)) continue;
    if (record.rectilinear && record.segments <= 5 && (box.height <= 2.5 || box.width <= 2.5)) continue;
    boxes.push({ box, weight: record.segments });
  }
  // Join drawings that touch or nearly do.
  const groups: Array<{ box: PdfBox; weight: number; parts: number }> = [];
  for (const item of boxes) {
    const grown = { x: item.box.x - 8, y: item.box.y - 8, width: item.box.width + 16, height: item.box.height + 16 };
    const hits = groups.filter((group) => overlapArea(group.box, grown) > 0);
    if (!hits.length) {
      groups.push({ box: item.box, weight: item.weight, parts: 1 });
      continue;
    }
    const merged = hits.reduce((acc, group) => ({ box: unionBox(acc.box, group.box)!, weight: acc.weight + group.weight, parts: acc.parts + group.parts }), { box: item.box, weight: item.weight, parts: 1 });
    for (const group of hits) groups.splice(groups.indexOf(group), 1);
    groups.push(merged);
  }
  return groups.filter((group) => group.box.width * group.box.height >= 900 && group.box.width >= 20 && group.box.height >= 20 && (group.weight >= 12 || group.parts >= 4)).map((group) => group.box);
}

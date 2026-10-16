import type { Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { LockedContentError } from "@/lib/doc/merge";
import { schema } from "@/lib/doc/schema";

/**
 * Fit laid-out pages by measuring them once and solving for font size and
 * line spacing. The editor measures real line boxes (a partly empty page
 * counts only for the space it fills). The numbers below are calculated from
 * that measurement; nothing here retries sizes against the document.
 *
 * Direct formatting is written onto the blocks in the fitted range only.
 * Named styles, the theme, and the document's default font are not modified,
 * and neither is text outside the range.
 */

export type FitKind = "half" | "page";

export type FitWord = { width: number; gap: number; breakBefore?: boolean };

export type FitMark = { from: number; to: number; size: number };

export type FitUnit = {
  pos: number;
  kind: "text" | "fixed" | "break";
  /** Used space from the previous unit's bottom to this unit's top, in CSS px. */
  gapBefore: number;
  /** True when this gap is paragraph or heading spacing that can be reduced. */
  gapScales?: boolean;
  lines?: number;
  /** Average line-box height, px. `lines * lineHeight` is the block's text height. */
  lineHeight?: number;
  /** Effective font size of unmarked text, points. */
  fontSize?: number;
  /** Unitless line spacing currently in effect. */
  lineSpacing?: number;
  width?: number;
  indent?: number;
  /** Fixed box height, px (images, rules). */
  height?: number;
  words?: FitWord[];
  marks?: FitMark[];
  canSize?: boolean;
  canLead?: boolean;
  canSpace?: boolean;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
};

export type FitMeasurement = {
  version: number;
  kind: FitKind;
  /** One page's content box, px. The top half is half of this. */
  pageContentHeight: number;
  /** Document body size, for the numbers reported to the user. */
  bodyFontSize: number;
  bodyLineSpacing: number;
  units: FitUnit[];
};

export type FitBlockPlan = {
  pos: number;
  fontSize?: number;
  lineSpacing?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  marks: FitMark[];
};

export type FitSolution = {
  unchanged: boolean;
  /** Set when the fit cannot be done; nothing is applied. */
  blocked: string | null;
  fontScale: number;
  lineScale: number;
  spacingScale: number;
  bodyFontSize: number;
  bodyLineSpacing: number;
  /** Predicted bottom of the fitted content, px. */
  height: number;
  target: number;
  blocks: FitBlockPlan[];
  summary: string;
};

const MIN_FONT = 6;
const MIN_LEADING = 0.8;

const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;

export function countLines(words: readonly FitWord[], width: number, indent = 0): number {
  if (!words.length) return 1;
  if (width <= 0) return Math.max(1, words.length);
  let lines = 1;
  let x = indent > 0 ? indent : 0;
  let limit = indent < 0 ? width - indent : width;
  const started = () => x > (lines === 1 && indent > 0 ? indent + 0.01 : 0.01);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (word.breakBefore && started()) {
      lines += 1;
      x = 0;
      limit = width;
    }
    if (word.width > 0 && started() && x + word.width > limit + 0.5) {
      lines += 1;
      x = 0;
      limit = width;
    }
    x += Math.max(0, word.width);
    const next = words[index + 1];
    if (next && !next.breakBefore) x += Math.max(0, word.gap);
  }
  return lines;
}

function targetOf(measurement: FitMeasurement) {
  return measurement.kind === "half" ? measurement.pageContentHeight / 2 : measurement.pageContentHeight;
}

function textUnits(units: readonly FitUnit[]) {
  return units.filter((unit) => unit.kind === "text" && (unit.fontSize ?? 0) > 0 && (unit.lineHeight ?? 0) > 0);
}

type TextMetrics = { font: number; leading: number; fontRatio: number; lines: number; lineHeight: number };

function textMetrics(unit: FitUnit, fontScale: number, lineScale: number): TextMetrics {
  const fontSize = unit.fontSize ?? MIN_FONT;
  const leading = unit.lineSpacing ?? 1.15;
  const fontFloor = Math.min(MIN_FONT, fontSize);
  const leadFloor = Math.min(MIN_LEADING, leading);
  const font = Math.max(fontFloor, round1(fontSize * fontScale));
  const nextLeading = Math.max(leadFloor, round2(leading * lineScale));
  const fontRatio = font / fontSize;
  const leadRatio = nextLeading / leading;
  const lines =
    Math.abs(font - fontSize) < 0.05
      ? Math.max(1, unit.lines ?? 1)
      : countLines(
          (unit.words ?? []).map((word) => ({ width: word.width * fontRatio, gap: word.gap * fontRatio, breakBefore: word.breakBefore })),
          unit.width ?? 0,
          (unit.indent ?? 0) * fontRatio,
        );
  return { font, leading: nextLeading, fontRatio, lines, lineHeight: (unit.lineHeight ?? 0) * fontRatio * leadRatio };
}

/** Height of the fitted units at these scales, in the same px the measurement used. */
export function predictFitHeight(units: readonly FitUnit[], fontScale: number, lineScale: number, spacingScale: number) {
  let total = 0;
  for (const unit of units) {
    if (unit.kind === "break") continue;
    const gap = unit.gapBefore * (unit.gapScales ? spacingScale : 1);
    if (unit.kind === "fixed") {
      total += gap + (unit.height ?? 0);
      continue;
    }
    const metrics = textMetrics(unit, fontScale, lineScale);
    total += gap + metrics.lines * metrics.lineHeight;
  }
  return total;
}

function largest(lo: number, hi: number, ok: (value: number) => boolean) {
  if (!ok(lo)) return null;
  if (ok(hi)) return hi;
  for (let step = 0; step < 32; step += 1) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

function minFontScale(units: readonly FitUnit[]) {
  let scale = 1;
  for (const unit of textUnits(units)) {
    const size = unit.fontSize ?? MIN_FONT;
    if (size > MIN_FONT) scale = Math.min(scale, MIN_FONT / size);
  }
  return scale;
}

function minLineScale(units: readonly FitUnit[]) {
  let scale = 1;
  for (const unit of textUnits(units)) {
    const leading = unit.lineSpacing ?? 1.15;
    if (leading > MIN_LEADING) scale = Math.min(scale, MIN_LEADING / leading);
  }
  return scale;
}

function breakSplits(units: readonly FitUnit[]) {
  const index = units.findIndex((unit) => unit.kind === "break");
  if (index < 0) return false;
  const before = units.slice(0, index).some((unit) => unit.kind !== "break");
  const after = units.slice(index + 1).some((unit) => unit.kind !== "break");
  return before && after;
}

function formatPt(value: number) {
  const rounded = round1(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function rangeLabel(kind: FitKind) {
  return kind === "half" ? "Page 1" : "Pages 1 and 2";
}

function targetLabel(kind: FitKind) {
  return kind === "half" ? "the top half of page 1" : "a single page";
}

function fillPhrase(measurement: FitMeasurement, occupied: number) {
  const pages = occupied / measurement.pageContentHeight;
  if (measurement.kind === "half") return `Page 1 is ${Math.round(pages * 100)}% full`;
  const rounded = Math.round(pages * 100) / 100;
  return `Pages 1 and 2 fill ${rounded} page${rounded === 1 ? "" : "s"}`;
}

function summaryFor(measurement: FitMeasurement, solution: Omit<FitSolution, "summary">): string {
  const where = targetLabel(measurement.kind);
  const source = rangeLabel(measurement.kind);
  if (solution.blocked) return solution.blocked;
  if (solution.unchanged) return `${fillPhrase(measurement, solution.height)}, which already fits in ${where}. Nothing was changed.`;
  const parts = [
    `${source} now fits in ${where}.`,
    `Body text is ${formatPt(solution.bodyFontSize)}pt with line spacing ${round2(solution.bodyLineSpacing)} (was ${formatPt(measurement.bodyFontSize)}pt and ${round2(measurement.bodyLineSpacing)}).`,
  ];
  if (solution.spacingScale < 0.999) {
    parts.push(
      `Paragraph spacing in that range is ${Math.round(solution.spacingScale * 100)}% of what it was, because ${formatPt(MIN_FONT)}pt and ${MIN_LEADING} line spacing were still too tall.`,
    );
  }
  parts.push("Text in that range with its own size was scaled by the same amount. Named styles, the theme, and text outside that range were not changed.");
  return parts.join(" ");
}

function blockPlan(unit: FitUnit, fontScale: number, lineScale: number, spacingScale: number, isFirst: boolean): FitBlockPlan | null {
  if (unit.kind !== "text") return null;
  const metrics = textMetrics(unit, fontScale, lineScale);
  const plan: FitBlockPlan = { pos: unit.pos, marks: [] };
  let changed = false;
  if (unit.canSize !== false && Math.abs(metrics.font - (unit.fontSize ?? metrics.font)) >= 0.05) {
    plan.fontSize = metrics.font;
    changed = true;
  }
  if (unit.canLead !== false && Math.abs(metrics.leading - (unit.lineSpacing ?? metrics.leading)) >= 0.005) {
    plan.lineSpacing = metrics.leading;
    changed = true;
  }
  if (spacingScale < 0.999 && unit.canSpace !== false) {
    if (!isFirst) plan.spaceBefore = round1((unit.spaceBeforePt ?? 0) * spacingScale);
    plan.spaceAfter = round1((unit.spaceAfterPt ?? 0) * spacingScale);
    changed = true;
  }
  if (unit.canSize !== false && Math.abs(metrics.fontRatio - 1) >= 0.005) {
    for (const mark of unit.marks ?? []) {
      const size = Math.max(Math.min(MIN_FONT, mark.size), round1(mark.size * metrics.fontRatio));
      if (Math.abs(size - mark.size) >= 0.05) plan.marks.push({ from: mark.from, to: mark.to, size });
    }
    if (plan.marks.length) changed = true;
  }
  return changed ? plan : null;
}

export function solveFit(measurement: FitMeasurement): FitSolution {
  const target = targetOf(measurement);
  const units = measurement.units;
  const occupied = predictFitHeight(units, 1, 1, 1);
  const base = {
    fontScale: 1,
    lineScale: 1,
    spacingScale: 1,
    bodyFontSize: measurement.bodyFontSize,
    bodyLineSpacing: measurement.bodyLineSpacing,
    height: occupied,
    target,
    blocks: [] as FitBlockPlan[],
  };
  const finish = (partial: Omit<FitSolution, "summary">): FitSolution => ({ ...partial, summary: summaryFor(measurement, partial) });

  if (!(measurement.pageContentHeight > 0) || !units.length) {
    return finish({ ...base, unchanged: true, blocked: null });
  }
  if (breakSplits(units)) {
    return finish({
      ...base,
      unchanged: true,
      blocked: `A page break in ${measurement.kind === "half" ? "page 1" : "the first two pages"} keeps the pages apart. Font size and spacing can't remove it, so nothing was changed.`,
    });
  }
  if (occupied <= target + 0.5) return finish({ ...base, unchanged: true, blocked: null });

  const fontFloor = minFontScale(units);
  const lineFloor = minLineScale(units);
  const fits = (fontScale: number, lineScale: number, spacingScale: number) => predictFitHeight(units, fontScale, lineScale, spacingScale) <= target + 0.5;

  let fontScale = largest(fontFloor, 1, (scale) => fits(scale, 1, 1));
  let lineScale = 1;
  let spacingScale = 1;
  if (fontScale == null) {
    fontScale = fontFloor;
    const leading = largest(lineFloor, 1, (scale) => fits(fontScale!, scale, 1));
    if (leading == null) {
      lineScale = lineFloor;
      const spacing = largest(0, 1, (scale) => fits(fontScale!, lineScale, scale));
      if (spacing == null) {
        return finish({
          ...base,
          fontScale,
          lineScale,
          spacingScale: 0,
          unchanged: true,
          blocked: `The content is still taller than ${targetLabel(measurement.kind)} at ${formatPt(MIN_FONT)}pt, line spacing ${MIN_LEADING}, and no paragraph spacing. Nothing was changed.`,
        });
      }
      spacingScale = spacing;
    } else lineScale = leading;
  }

  const bodyFont = Math.max(Math.min(MIN_FONT, measurement.bodyFontSize), round1(measurement.bodyFontSize * fontScale));
  const bodyLeading = Math.max(Math.min(MIN_LEADING, measurement.bodyLineSpacing), round2(measurement.bodyLineSpacing * lineScale));
  let firstText = true;
  const blocks: FitBlockPlan[] = [];
  for (const unit of units) {
    if (unit.kind !== "text") continue;
    const plan = blockPlan(unit, fontScale, lineScale, spacingScale, firstText);
    firstText = false;
    if (plan) blocks.push(plan);
  }
  return finish({
    unchanged: blocks.length === 0,
    blocked: null,
    fontScale,
    lineScale,
    spacingScale,
    bodyFontSize: bodyFont,
    bodyLineSpacing: bodyLeading,
    height: predictFitHeight(units, fontScale, lineScale, spacingScale),
    target,
    blocks,
  });
}

function locked(node: PMNode) {
  let found = false;
  node.descendants((child) => {
    if (found) return false;
    if (child.isText && child.marks.some((mark) => mark.type.name === "locked")) found = true;
    return !found;
  });
  return found;
}

/** Apply a solved fit. Styles, theme, and blocks that are not in the plan are left alone. */
export function applyFit(doc: PMNode, solution: FitSolution): Transform {
  const tr = new Transform(doc);
  if (solution.unchanged || solution.blocked || !solution.blocks.length) return tr;
  for (const block of solution.blocks) {
    const node = doc.nodeAt(block.pos);
    if (!node) continue;
    if (locked(node)) throw new LockedContentError();
    if (block.fontSize != null && "fontSize" in node.attrs && node.attrs.fontSize !== block.fontSize) tr.setNodeAttribute(block.pos, "fontSize", block.fontSize);
    if (block.lineSpacing != null && "lineHeight" in node.attrs && node.attrs.lineHeight !== String(block.lineSpacing)) {
      tr.setNodeAttribute(block.pos, "lineHeight", String(block.lineSpacing));
    }
    if (block.spaceBefore != null && "spaceBefore" in node.attrs) tr.setNodeAttribute(block.pos, "spaceBefore", block.spaceBefore);
    if (block.spaceAfter != null && "spaceAfter" in node.attrs) tr.setNodeAttribute(block.pos, "spaceAfter", block.spaceAfter);
    for (const mark of block.marks) {
      const from = block.pos + 1 + mark.from;
      const to = block.pos + 1 + mark.to;
      if (to <= from) continue;
      tr.removeMark(from, to, schema.marks.font_size!);
      tr.addMark(from, to, schema.mark("font_size", { size: `${formatPt(mark.size)}pt` }));
    }
  }
  return tr;
}

import type { PdfTextLine } from "@/lib/pdf/import/types";
import type { RenderedBlock, RenderedLine } from "@/lib/server/renders";

/**
 * Lining a rebuilt page up with the original PDF page: where each block's
 * first line sits on the editor's page against where that line is in the
 * PDF, and the spacing that moves every block onto its line.
 *
 * Space between blocks is set the only way that gives an exact gap: CSS lets
 * the space below one block and the space above the next overlap (margins
 * collapse to the larger), so the gap goes in full into the space above the
 * block and the space below the one before is set to nothing.
 */

export type BlockSpacing = { spaceBefore: number | null; spaceAfter: number | null; canBefore: boolean; canAfter: boolean };

export type SpacingChange = { spaceBefore?: number; spaceAfter?: number };

export type AlignmentPlan = {
  changes: Map<string, SpacingChange>;
  /** Each block placed against the original (before the changes): how far its first matched line is from where it should be, in points. */
  offsets: Array<{ id: string; text: string; offset: number }>;
};

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);

/** Where the rendered page's lines are, against the original's: matched by their words, in order down the page. */
export function compareLines(original: PdfTextLine[], rendered: RenderedLine[]) {
  const rows = rendered.map((line) => ({ line, words: new Set(words(line.text)) }));
  const report: Array<{ text: string; original: number; rendered: number | null; dx: number | null }> = [];
  let floor = -Infinity;
  for (const line of original) {
    const own = words(line.text);
    if (own.length < 3) continue;
    let best: { line: RenderedLine; score: number } | null = null;
    for (const row of rows) {
      if (row.line.y < floor - 2) continue;
      const hits = own.filter((word) => row.words.has(word)).length;
      const score = hits / own.length;
      if (score >= 0.6 && (!best || score > best.score + 0.05 || (Math.abs(score - best.score) <= 0.05 && Math.abs(row.line.y - line.baseline) < Math.abs(best.line.y - line.baseline)))) best = { line: row.line, score };
    }
    if (best) floor = best.line.y;
    report.push({ text: line.text.replace(/\t/g, " ").slice(0, 60), original: line.baseline, rendered: best?.line.y ?? null, dx: best ? best.line.x - line.box.x : null });
  }
  return report;
}

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * The spacing changes that put each block's first matched line where it is
 * in the original. In a box shared with the block before, the space between
 * them is inside the box (lib/editor/borders.ts) and set the same way; blocks
 * with no matched line (pictures, equations) move with the blocks around them.
 */
export function planAlignment(original: PdfTextLine[], rendered: RenderedLine[], blocks: RenderedBlock[], spacing: (id: string) => BlockSpacing | null, tolerance = 0.75): AlignmentPlan {
  const matches = compareLines(original, rendered).filter((row) => row.rendered !== null);
  const sorted = [...blocks].sort((a, b) => a.top - b.top);
  const changes = new Map<string, SpacingChange>();
  const offsets: AlignmentPlan["offsets"] = [];
  const change = (id: string, patch: SpacingChange) => changes.set(id, { ...changes.get(id), ...patch });
  let shift = 0;
  sorted.forEach((block, index) => {
    const match = matches.find((row) => row.rendered! >= block.top - 1 && row.rendered! <= block.bottom + 1);
    if (!match) return;
    const offset = match.rendered! - match.original;
    offsets.push({ id: block.id, text: match.text, offset: round(offset) });
    // A block sharing a box with the one before moves by the space inside the box, unless it isn't known.
    if (block.joined && block.inside === undefined) return;
    const effective = offset + shift;
    if (Math.abs(effective) < tolerance) return;
    const own = spacing(block.id);
    const previous = index > 0 ? sorted[index - 1]! : null;
    const before = previous ? spacing(previous.id) : null;
    if (!previous) {
      // The first block on the page: only the space above it moves it.
      if (!own?.canBefore) return;
      const now = own.spaceBefore ?? 0;
      const next = Math.max(0, now - effective);
      change(block.id, { spaceBefore: round(next) });
      shift += next - now;
      return;
    }
    const gap = block.joined ? block.inside! : block.top - previous.bottom;
    const wanted = Math.max(0, gap - effective);
    if (own?.canBefore) {
      change(block.id, { spaceBefore: round(wanted) });
      if (before?.canAfter) change(previous.id, { spaceAfter: 0 });
    } else if (before?.canAfter) {
      change(previous.id, { spaceAfter: round(wanted) });
    } else return;
    shift += wanted - gap;
  });
  return { changes, offsets };
}

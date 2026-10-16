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
  /** Blocks spacing can't move all the way onto their line, and why. */
  stuck: Array<{ id: string; text: string; offset: number; reason: string }>;
};

/** A line's words for matching: letters and digits, single letters too ("a = Set(a)" and "b = Set(b)" differ only in them). */
const tokens = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** How alike an original line and a rendered one are (0-1): how many of the original's words the rendered line holds, less for words it adds. */
function likeness(own: string[], other: string[]) {
  if (!own.length || !other.length) return 0;
  const left = new Map<string, number>();
  for (const word of other) left.set(word, (left.get(word) ?? 0) + 1);
  let hits = 0;
  for (const word of own) {
    const count = left.get(word) ?? 0;
    if (count) {
      hits += 1;
      left.set(word, count - 1);
    }
  }
  // A short line ("Question:", "else:") matches only a line of just its words.
  if (own.length < 3 && hits < Math.max(own.length, other.length)) return 0;
  return 0.75 * (hits / own.length) + 0.25 * (hits / other.length);
}

/** Lines alike enough to be the same line. */
const MATCH = 0.6;

export type LineMatch = { text: string; original: number; rendered: number | null; dx: number | null; /** Its text is on the page more than once: placed by order. */ repeated?: boolean };

/**
 * Where the rendered page's lines are, against the original's: each original
 * line paired with at most one rendered line, in order down both pages (the
 * pairing that matches the most text, by dynamic programming), so lines with
 * the same words ("a = Set(a)", "b = Set(b)", or two "else:") each find their own.
 */
export function compareLines(original: PdfTextLine[], rendered: RenderedLine[]): LineMatch[] {
  const own = original.map((line) => ({ line, words: tokens(line.text) })).filter((item) => item.words.length);
  const rows = [...rendered].sort((a, b) => a.y - b.y || a.x - b.x).map((line) => ({ line, words: tokens(line.text) }));
  const n = own.length;
  const m = rows.length;
  // best[i][j]: the most that lines i.. and rows j.. can match.
  const width = m + 1;
  const best = new Float64Array((n + 1) * width);
  const score = (i: number, j: number) => {
    const value = likeness(own[i]!.words, rows[j]!.words);
    // Between equally good pairings, the one nearer in height.
    return value >= MATCH ? value - Math.min(0.01, Math.abs(rows[j]!.line.y - own[i]!.line.baseline) / 1e5) : 0;
  };
  const scores = new Float64Array(n * Math.max(1, m));
  for (let i = 0; i < n; i += 1) for (let j = 0; j < m; j += 1) scores[i * m + j] = score(i, j);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const pair = scores[i * m + j]! > 0 ? scores[i * m + j]! + best[(i + 1) * width + j + 1]! : 0;
      best[i * width + j] = Math.max(pair, best[(i + 1) * width + j]!, best[i * width + j + 1]!);
    }
  }
  const paired = new Map<number, RenderedLine>();
  for (let i = 0, j = 0; i < n && j < m; ) {
    const here = best[i * width + j]!;
    const pair = scores[i * m + j]!;
    if (pair > 0 && Math.abs(here - (pair + best[(i + 1) * width + j + 1]!)) < 1e-9) {
      paired.set(i, rows[j]!.line);
      i += 1;
      j += 1;
    } else if (Math.abs(here - best[(i + 1) * width + j]!) < 1e-9) i += 1;
    else j += 1;
  }
  const counts = new Map<string, number>();
  for (const item of own) counts.set(item.words.join(" "), (counts.get(item.words.join(" ")) ?? 0) + 1);
  return own.map((item, index) => {
    const match = paired.get(index) ?? null;
    return {
      text: item.line.text.replace(/\t/g, " ").slice(0, 60),
      original: item.line.baseline,
      rendered: match?.y ?? null,
      dx: match ? match.x - item.line.box.x : null,
      ...(counts.get(item.words.join(" "))! > 1 ? { repeated: true } : {}),
    };
  });
}

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * The spacing changes that put each block's first matched line where it is
 * in the original. In a box shared with the block before, the space between
 * them is inside the box (lib/editor/borders.ts) and set the same way; blocks
 * with no matched line (pictures, equations) move with the blocks around them.
 */
export function planAlignment(original: PdfTextLine[], rendered: RenderedLine[], blocks: RenderedBlock[], spacing: (id: string) => BlockSpacing | null, tolerance = 0.75, anchors: ReadonlyMap<string, number> = new Map()): AlignmentPlan {
  const matches = compareLines(original, rendered).filter((row) => row.rendered !== null);
  const sorted = [...blocks].sort((a, b) => a.top - b.top);
  const changes = new Map<string, SpacingChange>();
  const offsets: AlignmentPlan["offsets"] = [];
  const stuck: AlignmentPlan["stuck"] = [];
  const change = (id: string, patch: SpacingChange) => changes.set(id, { ...changes.get(id), ...patch });
  let shift = 0;
  sorted.forEach((block, index) => {
    const match = matches.find((row) => row.rendered! >= block.top - 1 && row.rendered! <= block.bottom + 1);
    // A block with no text to match (a picture) may know where its top was.
    const anchor = anchors.get(block.id);
    if (!match && anchor === undefined) return;
    const offset = match ? match.rendered! - match.original : block.top - anchor!;
    const text = match ? match.text : "(picture)";
    offsets.push({ id: block.id, text, offset: round(offset) });
    const effective = offset + shift;
    const left = (moved: number, reason: string) => {
      if (Math.abs(effective - moved) >= 1.5) stuck.push({ id: block.id, text, offset: round(effective - moved), reason });
    };
    // A block sharing a box with the one before moves by the space inside the box, unless it isn't known.
    if (block.joined && block.inside === undefined) {
      left(0, "it shares a frame with the block above, and the space between them in the frame couldn't be measured");
      return;
    }
    if (Math.abs(effective) < tolerance) return;
    const own = spacing(block.id);
    const previous = index > 0 ? sorted[index - 1]! : null;
    const before = previous ? spacing(previous.id) : null;
    if (!previous) {
      // The first block on the page: only the space above it moves it.
      if (!own?.canBefore) {
        left(0, "it is the first block on the page and can't take space above it (a picture, list or table): put a paragraph with before= above it");
        return;
      }
      const now = own.spaceBefore ?? 0;
      const next = Math.max(0, now - effective);
      change(block.id, { spaceBefore: round(next) });
      left(now - next, "it is the first block on the page and already has no space above it, so it starts at the top margin: the original's text starts higher than the document's top margin, or something on it is taller than in the original (a frame's padding, a larger line height)");
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
    } else {
      left(0, "neither it nor the block above it can take spacing (pictures, lists and tables can't): put an empty paragraph between them with after=");
      return;
    }
    left(gap - wanted, "there is no space left between it and the block above: the block above is taller than in the original (its size, line=, a frame's padding, or its lines wrap differently)");
    shift += wanted - gap;
  });
  return { changes, offsets, stuck };
}

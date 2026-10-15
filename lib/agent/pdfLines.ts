import type { Node as PMNode } from "prosemirror-model";
import { encodeLineBreaks } from "@/lib/doc/lineBreaks";
import { TEX_MATH_FONT } from "@/lib/pdf/import/text";
import type { PdfTextLine } from "@/lib/pdf/import/types";

/**
 * Where a rebuilt page's paragraphs should break their lines: the PDF's
 * lines are matched word by word with the paragraphs' text, and each line
 * that runs the paragraph's full width (justified, as TeX sets it) gives a
 * break before the next line's first word. Equations in the text are matched
 * by counting what stands between the words around them.
 */

type DocWord = { norm: string; start: number; end: number; block: number };
type LineWord = { norm: string; line: number; /** For a word hyphenated across lines: its letters on the first line. */ split?: number };

const WORD = /[\p{L}\p{N}]+/gu;

const normalize = (text: string) => text.normalize("NFKC").toLowerCase();

/** A textblock's words outside equations, with their offsets in its content; and where its whitespace is. */
function blockWords(node: PMNode, block: number) {
  const words: DocWord[] = [];
  // Per content offset: "s" for whitespace that can break a line, "m" inside an equation, "x" anything else.
  let kinds = "";
  node.forEach((child, offset) => {
    if (child.isText) {
      const math = child.marks.some((mark) => mark.type.name === "math");
      const text = child.text ?? "";
      if (math) {
        kinds += "m".repeat(text.length);
        return;
      }
      for (const char of text) kinds += char === " " || char === "\u00a0" ? "s" : "x".repeat(char.length);
      for (const match of text.matchAll(WORD)) {
        const norm = normalize(match[0]);
        // NFKC can lengthen a word (ligatures); its place in the text is what matters.
        words.push({ norm, start: offset + match.index!, end: offset + match.index! + match[0].length, block });
      }
    } else {
      kinds += "x".repeat(child.nodeSize);
    }
  });
  return { words, kinds };
}

/** A line's words outside TeX's math fonts, in order. */
function lineWords(line: PdfTextLine) {
  return line.runs.filter((run) => !TEX_MATH_FONT.test(run.font)).flatMap((run) => [...normalize(run.text).matchAll(WORD)].map((match) => match[0]));
}

/** Pieces of a line between spaces, each with its words. */
function chunks(line: PdfTextLine) {
  return line.text
    .split(/\s+/)
    .filter(Boolean)
    .map((piece) => [...normalize(piece).matchAll(WORD)].map((match) => match[0]));
}

/** Longest common subsequence of two word lists: pairs of indices. */
function align(a: string[], b: string[]) {
  const n = a.length;
  const m = b.length;
  const table = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * (m + 1) + j] = a[i] === b[j] ? table[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(table[(i + 1) * (m + 1) + j]!, table[i * (m + 1) + j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * (m + 1) + j]! >= table[i * (m + 1) + j + 1]!) i += 1;
    else j += 1;
  }
  return pairs;
}

export type LockedLines = Array<{ pos: number; value: string | null }>;

/**
 * The line breaks to keep for the textblocks between `from` and `to` (one
 * original page), from that page's lines. Returns each textblock's new
 * `lineBreaks` value (null where its lines can't be matched).
 */
export function lineBreaksFor(doc: PMNode, from: number, to: number, lines: PdfTextLine[]): LockedLines {
  const blocks: Array<{ node: PMNode; pos: number }> = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) {
      if (!node.type.spec.code) blocks.push({ node, pos });
      return false;
    }
    return true;
  });
  if (!blocks.length) return [];
  const docWords: DocWord[] = [];
  const kinds: string[] = [];
  blocks.forEach(({ node }, index) => {
    const found = blockWords(node, index);
    docWords.push(...found.words);
    kinds.push(found.kinds);
  });

  // The page's words, a word broken by a hyphen at a line's end joined up again.
  const ordered = [...lines].sort((a, b) => a.baseline - b.baseline || a.box.x - b.box.x);
  const words: LineWord[] = [];
  ordered.forEach((line, index) => {
    const own = lineWords(line);
    const previous = words[words.length - 1];
    const hyphenated = previous && previous.line === index - 1 && /\p{L}-$/u.test(ordered[index - 1]!.text.trim()) && /^\p{Ll}/u.test(line.text.trim());
    own.forEach((norm, k) => {
      if (k === 0 && hyphenated) {
        previous.split = previous.norm.length;
        previous.norm += norm;
        return;
      }
      words.push({ norm, line: index });
    });
  });

  const pairs = align(
    words.map((word) => word.norm),
    docWords.map((word) => word.norm),
  );
  // Per line: its matched words, in order.
  const matched = ordered.map(() => [] as Array<{ word: LineWord; doc: DocWord }>);
  for (const [i, j] of pairs) matched[words[i]!.line]!.push({ word: words[i]!, doc: docWords[j]! });
  // A hyphenated word belongs to both lines it's on.
  for (const [i, j] of pairs) if (words[i]!.split !== undefined && matched[words[i]!.line + 1]) matched[words[i]!.line + 1]!.unshift({ word: words[i]!, doc: docWords[j]! });

  // Each line's block: where most of its words are.
  const lineBlock = matched.map((list) => {
    if (!list.length) return -1;
    const counts = new Map<number, number>();
    for (const item of list) counts.set(item.doc.block, (counts.get(item.doc.block) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  });

  const result: LockedLines = [];
  blocks.forEach(({ node, pos }, block) => {
    const own = ordered.map((line, index) => ({ line, index })).filter(({ index }) => lineBlock[index] === block);
    const fail = () => {
      if (node.attrs.lineBreaks) result.push({ pos, value: null });
    };
    if (own.length < 2) return fail();
    // Lines must follow one another on the page.
    if (own.some((item, k) => k > 0 && item.index !== own[k - 1]!.index + 1)) return fail();
    const right = Math.max(...own.map(({ line }) => line.box.x + line.box.width));
    const breaks: Array<{ at: number; hyphen: boolean }> = [];
    for (let k = 1; k < own.length; k += 1) {
      const before = own[k - 1]!;
      const after = own[k]!;
      // Only lines set to the full width are held: a short line ends where the text does anyway.
      if (before.line.box.x + before.line.box.width < right - 2) continue;
      const tail = matched[before.index]!.filter((item) => item.doc.block === block);
      const head = matched[after.index]!.filter((item) => item.doc.block === block);
      const last = tail[tail.length - 1];
      const first = head[0];
      if (!last || !first) return fail();
      if (last.doc === first.doc) {
        // A word broken by a hyphen: the break is inside it.
        if (last.word.split === undefined) return fail();
        breaks.push({ at: last.doc.start + last.word.split, hyphen: true });
        continue;
      }
      if (first.doc.start <= last.doc.end) return fail();
      const at = breakBetween(kinds[block]!, last.doc.end, first.doc.start, trailing(before.line, last.word), leading(after.line, first.word));
      if (at === null) return fail();
      breaks.push({ at, hyphen: false });
    }
    // Breaks in order, inside the text.
    if (!breaks.length || breaks.some((item, k) => item.at <= 0 || item.at >= node.content.size || (k > 0 && item.at <= breaks[k - 1]!.at))) return fail();
    const value = encodeLineBreaks(node, breaks);
    if (value !== node.attrs.lineBreaks) result.push({ pos, value });
  });
  return result;
}

/** How many pieces (between spaces) of a line come after the one holding this word. */
function trailing(line: PdfTextLine, word: LineWord) {
  const pieces = chunks(line);
  const norm = word.split !== undefined ? word.norm.slice(0, word.split) : word.norm;
  for (let k = pieces.length - 1; k >= 0; k -= 1) if (pieces[k]!.includes(norm)) return pieces.length - 1 - k;
  return 0;
}

/** How many pieces of a line come before the one holding this word. */
function leading(line: PdfTextLine, word: LineWord) {
  const pieces = chunks(line);
  for (let k = 0; k < pieces.length; k += 1) if (pieces[k]!.includes(word.norm)) return k;
  return 0;
}

/**
 * Where to break between two words of a paragraph (content offsets): at the
 * start of one of the pieces between them, after as many as the first
 * line had after its word (scaled when equations count differently).
 */
function breakBetween(kinds: string, end: number, start: number, tail: number, head: number) {
  // Starts of pieces (non-space after a space) in (end, start].
  const starts: number[] = [];
  for (let at = end + 1; at <= start; at += 1) if (kinds[at - 1] === "s" && kinds[at] !== "s") starts.push(at);
  if (!starts.length) return null;
  // The pieces between the two words, and the second word's own piece when it starts after a space.
  const between = starts[starts.length - 1] === start ? starts.length - 1 : starts.length;
  const index = tail + head === 0 ? 0 : tail + head === between ? tail : Math.round((between * tail) / (tail + head));
  return starts[Math.max(0, Math.min(starts.length - 1, index))]!;
}

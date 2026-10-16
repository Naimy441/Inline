/**
 * AI-tell cleanup for document text.
 *
 * Invisible junk (zero-width spaces, stray bidi marks, soft hyphens, and other
 * non-printing characters) is deleted. Joiners that belong to a script stay:
 * ZWJ/ZWNJ next to Arabic or Indic letters, ZWJ inside an emoji sequence, and
 * zero-width spaces between Thai, Lao, Myanmar, or Khmer letters. Real line
 * breaks, tabs, and Markdown list markers are ordinary characters and are kept.
 *
 * Visible AI symbols (em dashes, fake bullet glyphs, curly quotes, ellipsis
 * characters) are reported so the model can rewrite them. cleanAiTellText also
 * rewrites those symbols into plain punctuation and real Markdown lists.
 * Code, math, and any extra protected snippets are left alone.
 */

export type AiSymbolKind = "emdash" | "endash" | "bullet" | "ellipsis" | "quote";

export type AiSymbolHit = {
  kind: AiSymbolKind;
  count: number;
  title: string;
  /** A short sample of the match, so a rewrite can find it. */
  find: string;
  /** Plain replacement the clean pass uses. */
  replace: string;
  hint: string;
};

export type CleanResult = {
  text: string;
  removedInvisible: number;
  rewrites: AiSymbolHit[];
};

const KIND_ORDER: AiSymbolKind[] = ["emdash", "endash", "bullet", "ellipsis", "quote"];

const BULLET_LINE = /^([ \t]*)[•●○▪▫■□‣◦∙►▶▸▹➤❖⁃✓✔✗✘☐☑→⇒➜➔·][ \t]*/;
const INLINE_BULLET = /[•●○▪▫■□‣◦►▶▸▹➤❖⁃]/g;
const DOT_BULLET = /(^|\s)[·∙](?=\s|$)/g;
const REAL_LIST = /^[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])[ \t]/;

const HINTS: Record<AiSymbolKind, string> = {
  emdash: "Use a comma, a period, parentheses, or a hyphen.",
  endash: "Use a hyphen.",
  bullet: "Use a Markdown list (- item).",
  ellipsis: "Use three periods (...).",
  quote: "Use straight quotes (\" and ').",
};

const REPLACEMENTS: Record<AiSymbolKind, string> = {
  emdash: " - ",
  endash: " - ",
  bullet: "- ",
  ellipsis: "...",
  quote: '"',
};

function symbolTitle(kind: AiSymbolKind, count: number) {
  const plural = count === 1 ? "" : "s";
  switch (kind) {
    case "emdash":
      return `${count} em dash${count === 1 ? "" : "es"}`;
    case "endash":
      return `${count} en dash${plural}`;
    case "bullet":
      return `${count} bullet glyph${plural} outside a list`;
    case "ellipsis":
      return `${count} ellipsis character${plural}`;
    case "quote":
      return `${count} curly quote${plural}`;
  }
}

export function mergeSymbolHits(groups: readonly (readonly AiSymbolHit[])[]): AiSymbolHit[] {
  const map = new Map<AiSymbolKind, AiSymbolHit>();
  for (const hits of groups) {
    for (const hit of hits) {
      const prev = map.get(hit.kind);
      if (!prev) {
        map.set(hit.kind, { ...hit });
        continue;
      }
      prev.count += hit.count;
      prev.title = symbolTitle(hit.kind, prev.count);
    }
  }
  return KIND_ORDER.flatMap((kind) => {
    const hit = map.get(kind);
    return hit ? [hit] : [];
  });
}

/** Note appended when the model writes text that still has AI symbols, or when invisible characters were removed. */
export function formatWriteCheck(removed: number, symbols: readonly AiSymbolHit[]) {
  const lines: string[] = [];
  if (removed) lines.push(`Deleted ${removed} invisible character${removed === 1 ? "" : "s"} before applying the text.`);
  if (symbols.length) {
    lines.push("AI-tell check: rewrite this text before you finish. It still has AI symbols. Use normal punctuation and real Markdown lists.");
    for (const hit of symbols) lines.push(`- ${hit.title}${hit.find ? ` ("${hit.find}")` : ""}. ${hit.hint}`);
  }
  return lines.join("\n");
}

/** Summary of a document clean pass. */
export function formatCleanSummary(removed: number, rewrites: readonly AiSymbolHit[], locked: readonly AiSymbolHit[]) {
  const lines: string[] = [];
  if (removed) lines.push(`Deleted ${removed} invisible character${removed === 1 ? "" : "s"}.`);
  const changed = mergeSymbolHits([rewrites]);
  if (changed.length) {
    lines.push(`Rewrote ${changed.map((hit) => hit.title).join(", ")} into normal punctuation and Markdown lists.`);
    lines.push("Read the edited lines and smooth any sentence that reads awkwardly. Keep the plain punctuation and list markers.");
  }
  const held = mergeSymbolHits([locked]);
  if (held.length) lines.push(`Locked text was left unchanged and still has ${held.map((hit) => hit.title).join(", ")}.`);
  return lines.join(" ");
}

export function stripInvisible(text: string, protect: readonly string[] = []) {
  const ranges = coveredRanges(text, protect);
  let out = "";
  let removed = 0;
  let cursor = 0;
  const rtlCache = new Map<number, boolean>();
  const rtlAt = (index: number) => paragraphHasRtl(text, index, rtlCache);
  const take = (from: number, to: number) => {
    const slice = stripSlice(text, from, to, rtlAt);
    out += slice.text;
    removed += slice.removed;
  };
  for (const [start, end] of ranges) {
    take(cursor, start);
    out += text.slice(start, end);
    cursor = end;
  }
  take(cursor, text.length);
  return { text: out, removed };
}

export function findAiSymbols(text: string, protect: readonly string[] = []): AiSymbolHit[] {
  const masked = maskProtected(text, protect);
  const counts = new Map<AiSymbolKind, number>();
  const samples = new Map<AiSymbolKind, string>();
  const add = (kind: AiSymbolKind, sample: string) => {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (!samples.has(kind) && sample.trim()) samples.set(kind, clip(sample.trim(), 60));
  };
  for (const line of masked.split("\n")) scanLine(line, add);
  return mergeSymbolHits([
    KIND_ORDER.flatMap((kind) => {
      const count = counts.get(kind) ?? 0;
      if (!count) return [];
      const hit: AiSymbolHit = { kind, count, title: symbolTitle(kind, count), find: samples.get(kind) ?? "", replace: REPLACEMENTS[kind], hint: HINTS[kind] };
      return [hit];
    }),
  ]);
}

/** Delete invisible junk and rewrite AI symbols. Protected snippets (locked passages) stay as written. */
export function cleanAiTellText(text: string, protect: readonly string[] = []): CleanResult {
  const stripped = stripInvisible(text, protect);
  const rewrites = findAiSymbols(stripped.text, protect);
  return { text: rewriteSymbols(stripped.text, protect), removedInvisible: stripped.removed, rewrites };
}

function scanLine(line: string, add: (kind: AiSymbolKind, sample: string) => void) {
  const realList = REAL_LIST.test(line);
  let body = line;
  if (!realList) {
    const fake = BULLET_LINE.exec(line);
    if (fake) {
      add("bullet", line);
      body = line.slice(fake[0].length);
    }
  }
  eachMatch(INLINE_BULLET, body, () => add("bullet", line));
  eachMatch(DOT_BULLET, body, () => add("bullet", line));
  eachMatch(/[—―]/g, line, () => add("emdash", line));
  const withoutRanges = line.replace(/\d[ \t]*–[ \t]*\d/g, (match) => " ".repeat(match.length));
  eachMatch(/–/g, withoutRanges, () => add("endash", line));
  eachMatch(/…/g, line, () => add("ellipsis", line));
  eachMatch(/[“”‘’«»‹›]/g, line, () => add("quote", line));
}

function eachMatch(pattern: RegExp, text: string, visit: () => void) {
  pattern.lastIndex = 0;
  for (const _match of text.matchAll(pattern)) visit();
}

function rewriteSymbols(text: string, protect: readonly string[]) {
  const ranges = coveredRanges(text, protect);
  const saved: string[] = [];
  let masked = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    masked += text.slice(cursor, start);
    saved.push(text.slice(start, end));
    masked += `\uE000AI${saved.length - 1}\uE001`;
    cursor = end;
  }
  masked += text.slice(cursor);
  const rewritten = masked.split("\n").map(rewriteLine).join("\n");
  return rewritten.replace(/\uE000AI(\d+)\uE001/g, (_match, index: string) => saved[Number(index)] ?? "");
}

function rewriteLine(line: string) {
  const trailed = /[ \t]$/.test(line);
  let next = line;
  if (!REAL_LIST.test(next)) next = next.replace(BULLET_LINE, "$1- ");
  const ranges: string[] = [];
  next = next.replace(/\d[ \t]*–[ \t]*\d/g, (match) => {
    ranges.push(match);
    return `%%R${ranges.length - 1}%%`;
  });
  next = next.replace(/^[ \t]*[—―–][ \t]*/, "-- ");
  next = next.replace(/[ \t]*[—―–][ \t]*/g, " - ");
  next = next.replace(/%%R(\d+)%%/g, (_match, index: string) => ranges[Number(index)] ?? "");
  next = next.replace(/…/g, "...");
  next = next.replace(/[“”«»]/g, '"');
  next = next.replace(/[‘’‹›]/g, "'");
  next = next.replace(INLINE_BULLET, "-");
  next = next.replace(DOT_BULLET, "$1-");
  if (!trailed) next = next.replace(/[ \t]+$/g, "");
  return next;
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

// --- invisible characters ---------------------------------------------------

const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/;

function paragraphHasRtl(text: string, index: number, cache: Map<number, boolean>) {
  const start = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const cached = cache.get(start);
  if (cached !== undefined) return cached;
  const end = text.indexOf("\n", start);
  const rtl = RTL.test(text.slice(start, end < 0 ? text.length : end));
  cache.set(start, rtl);
  return rtl;
}

function stripSlice(text: string, from: number, to: number, rtlAt: (index: number) => boolean) {
  let out = "";
  let removed = 0;
  for (let i = from; i < to; ) {
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const action = classify(cp, text, i, rtlAt(i));
    if (action === "keep") out += text.slice(i, i + len);
    else if (action === "newline") out += "\n";
    else removed += 1;
    i += len;
  }
  return { text: out, removed };
}

function classify(cp: number, text: string, index: number, rtl: boolean): "keep" | "drop" | "newline" {
  if (cp === 0x2028 || cp === 0x2029) return "newline";
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return "keep";
  if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return "drop";
  if (cp === 0xfeff || cp === 0x00ad || cp === 0x034f || cp === 0x2060) return "drop";
  if (cp >= 0x2061 && cp <= 0x2064) return "drop";
  if (cp >= 0x206a && cp <= 0x206f) return "drop";
  if (cp >= 0xfff9 && cp <= 0xfffb) return "drop";
  if (cp === 0x180e) return neighborMatches(text, index, isMongolian) ? "keep" : "drop";
  if (cp === 0x17b4 || cp === 0x17b5) return neighborMatches(text, index, isKhmer) ? "keep" : "drop";
  if (cp === 0x115f || cp === 0x1160 || cp === 0x3164 || cp === 0xffa0) return neighborMatches(text, index, isHangul) ? "keep" : "drop";
  if (cp === 0x200b) return neighborMatches(text, index, usesZwsp) ? "keep" : "drop";
  if (cp === 0x200d) return keepZwj(text, index) ? "keep" : "drop";
  if (cp === 0x200c) return keepZwnj(text, index) ? "keep" : "drop";
  if (isBidi(cp)) return rtl ? "keep" : "drop";
  if (isVariationSelector(cp)) return previousIsBase(text, index) ? "keep" : "drop";
  if (cp >= 0x180b && cp <= 0x180d) return neighborMatches(text, index, isMongolian) ? "keep" : "drop";
  if (isTag(cp)) return inEmojiTagSequence(text, index) ? "keep" : "drop";
  return "keep";
}

function isBidi(cp: number) {
  return cp === 0x061c || cp === 0x200e || cp === 0x200f || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
}

function isVariationSelector(cp: number) {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

function isTag(cp: number) {
  return cp === 0xe0001 || (cp >= 0xe0020 && cp <= 0xe007f);
}

function isMongolian(cp: number) {
  return cp >= 0x1800 && cp <= 0x18af;
}

function isKhmer(cp: number) {
  return cp >= 0x1780 && cp <= 0x17ff;
}

function isHangul(cp: number) {
  return (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xa960 && cp <= 0xa97f) || (cp >= 0xd7b0 && cp <= 0xd7ff);
}

function usesZwsp(cp: number) {
  return (cp >= 0x0e00 && cp <= 0x0eff) || (cp >= 0x1000 && cp <= 0x109f) || (cp >= 0x1780 && cp <= 0x17ff);
}

function isIndic(cp: number) {
  return (cp >= 0x0900 && cp <= 0x0dff) || (cp >= 0x1000 && cp <= 0x109f) || (cp >= 0x1780 && cp <= 0x17ff) || (cp >= 0x1900 && cp <= 0x194f) || (cp >= 0x1b00 && cp <= 0x1b7f) || (cp >= 0x1cd0 && cp <= 0x1cff) || (cp >= 0xa8e0 && cp <= 0xa8ff);
}

function isArabic(cp: number) {
  return (cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) || (cp >= 0x08a0 && cp <= 0x08ff) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfefc);
}

function usesZwnj(cp: number) {
  return isArabic(cp) || isIndic(cp) || (cp >= 0x0700 && cp <= 0x074f) || (cp >= 0x0780 && cp <= 0x07bf);
}

function isEmoji(cp: number) {
  return (cp >= 0x1f1e6 && cp <= 0x1f1ff) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x2600 && cp <= 0x27bf);
}

function isFormat(cp: number) {
  return cp === 0x00ad || cp === 0x034f || cp === 0x061c || cp === 0x180e || cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x200e || cp === 0x200f || cp === 0x2060 || cp === 0xfeff || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2061 && cp <= 0x206f) || isVariationSelector(cp) || isTag(cp);
}

function neighborMatches(text: string, index: number, test: (cp: number) => boolean) {
  const prev = adjacent(text, index, -1);
  const next = adjacent(text, index, 1);
  return (prev != null && test(prev)) || (next != null && test(next));
}

function keepZwj(text: string, index: number) {
  const prev = adjacent(text, index, -1);
  const next = adjacent(text, index, 1);
  if (prev != null && isIndic(prev)) return true;
  if (next != null && isIndic(next)) return true;
  return prev != null && next != null && isEmoji(prev) && isEmoji(next);
}

function keepZwnj(text: string, index: number) {
  return neighborMatches(text, index, usesZwnj);
}

function previousIsBase(text: string, index: number) {
  const prev = previousCodePoint(text, index);
  if (!prev) return false;
  const cp = prev.cp;
  if (cp <= 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return false;
  if (isVariationSelector(cp) || isFormat(cp)) return false;
  return true;
}

function inEmojiTagSequence(text: string, index: number) {
  let cursor = index;
  for (let step = 0; step < 32; step += 1) {
    const prev = previousCodePoint(text, cursor);
    if (!prev) return false;
    if (prev.cp === 0x1f3f4) return true;
    if (isTag(prev.cp) || isVariationSelector(prev.cp) || prev.cp === 0x200d) {
      cursor = prev.start;
      continue;
    }
    return false;
  }
  return false;
}

/** Neighbor code point, skipping variation selectors so a joiner still sees the base emoji. */
function adjacent(text: string, index: number, dir: -1 | 1) {
  let cursor = dir < 0 ? index : index + widthAt(text, index);
  for (let step = 0; step < 4; step += 1) {
    const found = dir < 0 ? previousCodePoint(text, cursor) : nextCodePoint(text, cursor);
    if (!found) return null;
    if (isVariationSelector(found.cp)) {
      cursor = dir < 0 ? found.start : found.start + (found.cp > 0xffff ? 2 : 1);
      continue;
    }
    return found.cp;
  }
  return null;
}

function widthAt(text: string, index: number) {
  const cp = text.codePointAt(index) ?? 0;
  return cp > 0xffff ? 2 : 1;
}

function previousCodePoint(text: string, index: number) {
  if (index <= 0) return null;
  const tail = index - 1;
  const unit = text.charCodeAt(tail);
  if (unit >= 0xdc00 && unit <= 0xdfff && tail > 0) {
    const lead = text.charCodeAt(tail - 1);
    if (lead >= 0xd800 && lead <= 0xdbff) return { cp: text.codePointAt(tail - 1)!, start: tail - 1 };
  }
  return { cp: unit, start: tail };
}

function nextCodePoint(text: string, index: number) {
  if (index >= text.length) return null;
  const cp = text.codePointAt(index)!;
  return { cp, start: index };
}

// --- regions the cleaner must not touch ------------------------------------

function coveredRanges(text: string, protect: readonly string[]) {
  const ranges = [...syntaxRanges(text), ...snippetRanges(text, protect)];
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

function snippetRanges(text: string, protect: readonly string[]) {
  const ranges: Array<[number, number]> = [];
  for (const snippet of protect) {
    if (!snippet) continue;
    let from = 0;
    while (from <= text.length) {
      const at = text.indexOf(snippet, from);
      if (at < 0) break;
      ranges.push([at, at + snippet.length]);
      from = at + snippet.length;
    }
  }
  return ranges;
}

/** Fenced code, inline code, and math. Those can contain the symbols on purpose. */
function syntaxRanges(text: string) {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("$$", i)) {
      const close = text.indexOf("$$", i + 2);
      const end = close === -1 ? text.length : close + 2;
      ranges.push([i, end]);
      i = end;
      continue;
    }
    if (text.startsWith("```", i) || text.startsWith("~~~", i)) {
      const fence = text.slice(i, i + 3);
      const close = text.indexOf(fence, i + 3);
      const end = close === -1 ? text.length : close + fence.length;
      ranges.push([i, end]);
      i = end;
      continue;
    }
    if (text[i] === "`") {
      let ticks = 1;
      while (text[i + ticks] === "`") ticks += 1;
      const closer = text.indexOf("`".repeat(ticks), i + ticks);
      if (closer !== -1) {
        ranges.push([i, closer + ticks]);
        i = closer + ticks;
        continue;
      }
    }
    const ahead = text[i + 1];
    if (text[i] === "$" && text[i - 1] !== "\\" && ahead && !/\s/.test(ahead) && ahead !== "$") {
      let j = i + 1;
      while (j < text.length && text[j] !== "\n" && text[j] !== "$") j += 1;
      if (text[j] === "$" && j > i + 1 && !/\s/.test(text[j - 1]!)) {
        ranges.push([i, j + 1]);
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }
  return ranges;
}

function maskProtected(text: string, protect: readonly string[]) {
  const ranges = coveredRanges(text, protect);
  let masked = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    masked += text.slice(cursor, start);
    masked += text.slice(start, end).replace(/[^\n]/g, " ");
    cursor = end;
  }
  return masked + text.slice(cursor);
}

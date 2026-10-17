/**
 * Insert → Special characters.
 *
 * The grid is the Unicode Name property: every assigned character in Unicode
 * 18.0.0, grouped the way Google Docs groups them (a category, then the
 * Unicode block). Controls, surrogates, private use, and noncharacters have
 * no character name and are not listed. The catalog itself is fetched when
 * the dialog opens (`public/unicode/catalog.json`), so the editor bundle
 * does not carry it.
 */

export const CATALOG_URL = "/unicode/catalog.json";
export const UNICODE_VERSION = "18.0.0";

const HANGUL_L = ["G", "GG", "N", "D", "DD", "R", "M", "B", "BB", "S", "SS", "", "J", "JJ", "C", "K", "T", "P", "H"];
const HANGUL_V = ["A", "AE", "YA", "YAE", "EO", "E", "YEO", "YE", "O", "WA", "WAE", "OE", "YO", "U", "WEO", "WE", "WI", "YU", "EU", "YI", "I"];
const HANGUL_T = ["", "G", "GG", "GS", "N", "NJ", "NH", "D", "L", "LG", "LM", "LB", "LS", "LT", "LP", "LH", "M", "B", "BS", "S", "SS", "NG", "J", "C", "K", "T", "P", "H"];
const HANGUL_START = 0xac00;
const HANGUL_END = 0xd7a3;

export type CharacterSource = {
  readonly count: number;
  at(index: number): number;
};

export type CharacterBlock = {
  readonly name: string;
  readonly count: number;
  readonly source: CharacterSource;
};

export type CharacterCategory = {
  readonly name: string;
  readonly blocks: readonly CharacterBlock[];
  readonly source: CharacterSource;
};

export type CharacterCatalog = {
  readonly version: string;
  readonly count: number;
  readonly categories: readonly CharacterCategory[];
  characterName(cp: number): string;
  glyphFor(cp: number): string;
  isAssigned(cp: number): boolean;
  searchCharacters(query: string): CharacterSource;
};

type Span = { start: number; end: number };

type Pattern = {
  start: number;
  end: number;
  prefix: string;
  phrase: string;
  words: string[];
  hangul: boolean;
};

const EMPTY: CharacterSource = {
  count: 0,
  at() {
    throw new RangeError("character index");
  },
};

/** U+00E9, at least four digits, the way the Unicode standard writes a code point. */
export function formatCodePoint(cp: number) {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A code point typed as U+00E9, 0x00E9, or 00E9. One digit needs the U+ so it is not a name search. */
export function parseCodePoint(query: string) {
  const q = query.trim();
  const prefixed = /^(?:u\+|0x)([0-9a-f]{1,6})$/i.exec(q);
  const bare = /^[0-9a-f]{2,6}$/i.exec(q);
  const hex = prefixed?.[1] ?? bare?.[0] ?? null;
  if (!hex) return null;
  const cp = Number.parseInt(hex, 16);
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return null;
  return cp;
}

export function hangulName(cp: number) {
  const index = cp - HANGUL_START;
  const l = Math.floor(index / 588);
  const v = Math.floor((index % 588) / 28);
  const t = index % 28;
  return `HANGUL SYLLABLE ${HANGUL_L[l]}${HANGUL_V[v]}${HANGUL_T[t]}`;
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeU32(value: string) {
  const bytes = decodeBase64(value);
  if (bytes.byteLength % 4 !== 0) throw new Error("special character catalog is truncated");
  const out = new Uint32Array(bytes.byteLength / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i += 1) out[i] = view.getUint32(i * 4, true);
  return out;
}

function decodeU16(value: string) {
  const bytes = decodeBase64(value);
  if (bytes.byteLength % 2 !== 0) throw new Error("special character catalog is truncated");
  const out = new Uint16Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i += 1) out[i] = view.getUint16(i * 2, true);
  return out;
}

function sourceFromSpans(spans: readonly Span[]): CharacterSource {
  if (!spans.length) return EMPTY;
  const cumulative = new Uint32Array(spans.length);
  let total = 0;
  for (let i = 0; i < spans.length; i += 1) {
    total += spans[i].end - spans[i].start + 1;
    cumulative[i] = total;
  }
  return {
    count: total,
    at(index: number) {
      if (index < 0 || index >= total) throw new RangeError("character index");
      let lo = 0;
      let hi = spans.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulative[mid] <= index) lo = mid + 1;
        else hi = mid;
      }
      const previous = lo === 0 ? 0 : cumulative[lo - 1];
      return spans[lo].start + (index - previous);
    },
  };
}

function runsToSpans(runs: readonly (readonly number[])[]): Span[] {
  return runs.map(([start, end]) => ({ start, end }));
}

function mergeSpans(spans: readonly Span[]) {
  if (!spans.length) return [];
  const ordered = spans.map((span) => ({ start: span.start, end: span.end }));
  if (ordered.length > 1) ordered.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Span[] = [];
  for (const span of ordered) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end + 1) last.end = Math.max(last.end, span.end);
    else merged.push(span);
  }
  return merged;
}

function containsSpan(spans: readonly Span[], cp: number) {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    if (cp < span.start) hi = mid - 1;
    else if (cp > span.end) lo = mid + 1;
    else return true;
  }
  return false;
}

function nameOffsets(parts: readonly string[]) {
  const offsets = new Uint32Array(parts.length + 1);
  let pos = 0;
  for (let i = 0; i < parts.length; i += 1) {
    offsets[i] = pos;
    pos += parts[i].length;
    if (i !== parts.length - 1) pos += 1;
  }
  offsets[parts.length] = pos;
  return offsets;
}

function nameIndexAt(offsets: Uint32Array, count: number, pos: number) {
  let lo = 0;
  let hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= pos) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi;
}

/** Substring hits in a newline-separated name blob, as code points `origin + index`. */
function blobMatches(blob: string, offsets: Uint32Array, origin: number | Uint32Array, query: string) {
  const found: number[] = [];
  const count = offsets.length - 1;
  let from = 0;
  while (from < blob.length) {
    const at = blob.indexOf(query, from);
    if (at < 0) break;
    const index = nameIndexAt(offsets, count, at);
    const start = offsets[index];
    const end = index + 1 === count ? blob.length : offsets[index + 1] - 1;
    if (at >= start && at + query.length <= end) {
      found.push(typeof origin === "number" ? origin + index : origin[index]);
      from = end + 1;
    } else from = at + 1;
  }
  const spans: Span[] = [];
  for (const cp of found) {
    const last = spans[spans.length - 1];
    if (last && cp === last.end + 1) last.end = cp;
    else if (!last || cp !== last.end) spans.push({ start: cp, end: cp });
  }
  return spans;
}

function hexDigits(cp: number) {
  const hex = cp.toString(16);
  return hex.length < 4 ? hex.padStart(4, "0") : hex;
}

function hexSpans(start: number, end: number, fragment: string) {
  const maxDigits = Math.max(4, end.toString(16).length);
  if (fragment.length > maxDigits) return [];
  const spans: Span[] = [];
  let run = -1;
  for (let cp = start; cp <= end; cp += 1) {
    if (hexDigits(cp).includes(fragment)) {
      if (run < 0) run = cp;
    } else if (run >= 0) {
      spans.push({ start: run, end: cp - 1 });
      run = -1;
    }
  }
  if (run >= 0) spans.push({ start: run, end });
  return spans;
}

function asObject(value: unknown, label: string) {
  if (!value || typeof value !== "object") throw new Error(`special character catalog ${label} is missing`);
  return value as Record<string, unknown>;
}

export function createCatalog(input: unknown): CharacterCatalog {
  const data = asObject(input, "file");
  const version = data.version;
  if (typeof version !== "string") throw new Error("special character catalog has no version");
  const count = data.count;
  if (typeof count !== "number") throw new Error("special character catalog has no count");
  const rawCategories = data.categories;
  if (!Array.isArray(rawCategories)) throw new Error("special character catalog has no categories");

  const names = asObject(data.names, "names");
  const dict = names.dict;
  if (!Array.isArray(dict) || dict.some((word) => typeof word !== "string")) throw new Error("special character catalog dictionary is invalid");
  const words = decodeU16(String(names.words));
  const wordOffs = decodeU32(String(names.wordOffs));
  const nameCps = decodeU32(String(names.cps));
  const nameCount = nameCps.length;
  if (wordOffs.length !== nameCount + 1) throw new Error("special character catalog names are truncated");

  const explicitName = (index: number) => {
    const from = wordOffs[index];
    const to = wordOffs[index + 1];
    let name = dict[words[from]] as string;
    for (let i = from + 1; i < to; i += 1) name += ` ${dict[words[i]] as string}`;
    return name;
  };

  const explicitParts = new Array<string>(nameCount);
  for (let i = 0; i < nameCount; i += 1) explicitParts[i] = explicitName(i).toLowerCase();
  const explicitBlob = explicitParts.join("\n");
  const explicitOffs = nameOffsets(explicitParts);

  const hangulCount = HANGUL_END - HANGUL_START + 1;
  const hangulParts = new Array<string>(hangulCount);
  for (let i = 0; i < hangulCount; i += 1) hangulParts[i] = hangulName(HANGUL_START + i).toLowerCase();
  const hangulBlob = hangulParts.join("\n");
  const hangulOffs = nameOffsets(hangulParts);

  const patterns: Pattern[] = [];
  if (!Array.isArray(data.patterns)) throw new Error("special character catalog has no patterns");
  for (const entry of data.patterns) {
    const pattern = asObject(entry, "pattern");
    const prefix = String(pattern.prefix ?? "");
    const phrase = prefix.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/ +/g, " ");
    patterns.push({
      start: Number(pattern.start),
      end: Number(pattern.end),
      prefix,
      phrase,
      words: phrase.split(" ").filter(Boolean),
      hangul: pattern.hangul === true,
    });
  }

  const combining = Array.isArray(data.combining) ? runsToSpans(data.combining as number[][]) : [];

  let listed = 0;
  const categorySpans: Span[][] = [];
  const categories: CharacterCategory[] = rawCategories.map((entry) => {
    const category = asObject(entry, "category");
    const rawBlocks = category.blocks;
    if (!Array.isArray(rawBlocks)) throw new Error(`special character catalog category ${String(category.name)} has no blocks`);
    const spans: Span[] = [];
    const blocks: CharacterBlock[] = rawBlocks.map((blockEntry) => {
      const block = asObject(blockEntry, "block");
      const runs = block.runs;
      if (!Array.isArray(runs)) throw new Error(`special character catalog block ${String(block.name)} has no runs`);
      const blockSpans = runsToSpans(runs as number[][]);
      spans.push(...blockSpans);
      const source = sourceFromSpans(blockSpans);
      listed += source.count;
      return { name: String(block.name), count: source.count, source };
    });
    categorySpans.push(spans);
    return { name: String(category.name), blocks, source: sourceFromSpans(mergeSpans(spans.slice())) };
  });
  if (listed !== count) throw new Error(`special character catalog lists ${listed} characters, not ${count}`);

  // Category order is not code point order, so assignment is a sorted merge of every run.
  const assigned = mergeSpans(categorySpans.flat());

  function characterName(cp: number) {
    const exact = binarySearch(nameCps, cp);
    if (exact >= 0) return explicitName(exact);
    for (const pattern of patterns) {
      if (cp < pattern.start || cp > pattern.end) continue;
      if (pattern.hangul) return hangulName(cp);
      return pattern.prefix + hexDigits(cp).toUpperCase();
    }
    return "";
  }

  function patternMatches(pattern: Pattern, query: string) {
    if (pattern.hangul) return false;
    if (query.length >= 3 && (pattern.phrase.includes(query) || pattern.words.some((word) => word.startsWith(query)))) return "all" as const;
    if (/^[0-9a-f]{4,6}$/.test(query)) return "hex" as const;
    const lead = query.replace(/[-0-9a-f]+$/, "");
    const rest = query.slice(lead.length).replace(/^-/, "");
    if (lead.length >= 3 && /^[0-9a-f]{2,6}$/.test(rest) && (pattern.phrase.includes(lead) || pattern.words.some((word) => word.startsWith(lead)))) return "hex-rest" as const;
    return false;
  }

  return {
    version,
    count,
    categories,
    characterName,
    glyphFor(cp: number) {
      const character = String.fromCodePoint(cp);
      return containsSpan(combining, cp) ? `\u25CC${character}` : character;
    },
    isAssigned(cp: number) {
      return containsSpan(assigned, cp);
    },
    searchCharacters(query: string) {
      const raw = query.trim();
      if (!raw) return EMPTY;
      const ql = raw.toLowerCase();
      const spans: Span[] = [];
      const code = parseCodePoint(raw);
      if (code != null && containsSpan(assigned, code)) spans.push({ start: code, end: code });
      const scalars = Array.from(raw);
      if (scalars.length === 1) {
        const ch = scalars[0].codePointAt(0)!;
        if (containsSpan(assigned, ch)) spans.push({ start: ch, end: ch });
      }
      if (!ql.includes("\n")) spans.push(...blobMatches(explicitBlob, explicitOffs, nameCps, ql));
      if (ql.length >= 2 && !/[0-9+]/.test(ql)) {
        if ("hangul syllable".includes(ql)) spans.push({ start: HANGUL_START, end: HANGUL_END });
        else spans.push(...blobMatches(hangulBlob, hangulOffs, HANGUL_START, ql));
      }
      for (const pattern of patterns) {
        const kind = patternMatches(pattern, ql);
        if (kind === "all") spans.push({ start: pattern.start, end: pattern.end });
        else if (kind === "hex") spans.push(...hexSpans(pattern.start, pattern.end, ql));
        else if (kind === "hex-rest") spans.push(...hexSpans(pattern.start, pattern.end, ql.replace(/^.*?([0-9a-f]+)$/, "$1")));
      }
      return sourceFromSpans(mergeSpans(spans));
    },
  };
}

function binarySearch(values: Uint32Array, cp: number) {
  let lo = 0;
  let hi = values.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = values[mid];
    if (value === cp) return mid;
    if (value < cp) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

let loading: Promise<CharacterCatalog> | null = null;

/** Fetch and index the catalog. Cached for the rest of the page. */
export function loadSpecialCharacters() {
  loading ??= fetch(CATALOG_URL)
    .then(async (res) => {
      if (!res.ok) throw new Error(`Could not load special characters (${res.status})`);
      return createCatalog(await res.json());
    })
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

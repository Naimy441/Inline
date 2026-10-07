/**
 * Just enough of TrueType for a PDF to carry a font: the character map,
 * glyph advances and vertical metrics, and a subset that keeps only the
 * glyphs a document draws (glyph ids unchanged, the others emptied), so a
 * PDF made in a document's own fonts stays small. OpenType fonts with CFF
 * outlines (OTTO) are read for their metrics and embedded whole.
 */

type Table = { offset: number; length: number };

export type TrueTypeFont = {
  data: Uint8Array;
  cff: boolean;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  italicAngle: number;
  bbox: [number, number, number, number];
  postScriptName: string;
  bold: boolean;
  /** Unicode code point → glyph id. */
  glyphFor(codePoint: number): number;
  /** Advance width of a glyph in font units. */
  advance(glyph: number): number;
  /** The font with only these glyphs' outlines (and the outlines they're built from). */
  subset(glyphs: Iterable<number>): Uint8Array;
};

export function parseTrueType(data: Uint8Array): TrueTypeFont | null {
  try {
    return parse(data);
  } catch {
    return null;
  }
}

function parse(data: Uint8Array): TrueTypeFont | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (offset: number) => String.fromCharCode(data[offset]!, data[offset + 1]!, data[offset + 2]!, data[offset + 3]!);
  const signature = tag(0);
  const cff = signature === "OTTO";
  if (!cff && view.getUint32(0) !== 0x00010000 && signature !== "true") return null;
  const tables = new Map<string, Table>();
  const count = view.getUint16(4);
  for (let i = 0; i < count; i += 1) {
    const record = 12 + i * 16;
    tables.set(tag(record), { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) });
  }
  const head = tables.get("head");
  const hhea = tables.get("hhea");
  const hmtx = tables.get("hmtx");
  const maxp = tables.get("maxp");
  const cmap = tables.get("cmap");
  if (!head || !hhea || !hmtx || !maxp || !cmap) return null;

  const unitsPerEm = view.getUint16(head.offset + 18);
  const bbox: [number, number, number, number] = [view.getInt16(head.offset + 36), view.getInt16(head.offset + 38), view.getInt16(head.offset + 40), view.getInt16(head.offset + 42)];
  const longLoca = view.getInt16(head.offset + 50) === 1;
  const numGlyphs = view.getUint16(maxp.offset + 4);
  const numMetrics = view.getUint16(hhea.offset + 34);
  let ascent = view.getInt16(hhea.offset + 4);
  let descent = view.getInt16(hhea.offset + 6);
  let capHeight = ascent;
  const os2 = tables.get("OS/2");
  let bold = false;
  if (os2) {
    const version = view.getUint16(os2.offset);
    bold = view.getUint16(os2.offset + 4) >= 600;
    if (os2.length >= 78) {
      ascent = view.getInt16(os2.offset + 68);
      descent = view.getInt16(os2.offset + 70);
    }
    if (version >= 2 && os2.length >= 90) capHeight = view.getInt16(os2.offset + 88);
  }
  const post = tables.get("post");
  const italicAngle = post ? view.getInt32(post.offset + 4) / 65536 : 0;

  const advance = (glyph: number) => {
    const index = Math.min(glyph, numMetrics - 1);
    return view.getUint16(hmtx.offset + index * 4);
  };

  // The best Unicode subtable: format 12 (all planes), else format 4 (the basic plane).
  let format4: number | null = null;
  let format12: number | null = null;
  const subtables = view.getUint16(cmap.offset + 2);
  for (let i = 0; i < subtables; i += 1) {
    const platform = view.getUint16(cmap.offset + 4 + i * 8);
    const encoding = view.getUint16(cmap.offset + 6 + i * 8);
    const offset = cmap.offset + view.getUint32(cmap.offset + 8 + i * 8);
    const format = view.getUint16(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12) format12 ??= offset;
    if (format === 4) format4 ??= offset;
  }
  const cache = new Map<number, number>();
  const lookup = (code: number) => {
    if (format12 != null) {
      const groups = view.getUint32(format12 + 12);
      for (let lo = 0, hi = groups - 1; lo <= hi; ) {
        const mid = (lo + hi) >> 1;
        const at = format12 + 16 + mid * 12;
        const start = view.getUint32(at);
        const end = view.getUint32(at + 4);
        if (code < start) hi = mid - 1;
        else if (code > end) lo = mid + 1;
        else return view.getUint32(at + 8) + (code - start);
      }
      return 0;
    }
    if (format4 == null || code > 0xffff) return 0;
    const segments = view.getUint16(format4 + 6) / 2;
    const ends = format4 + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    for (let i = 0; i < segments; i += 1) {
      if (code > view.getUint16(ends + i * 2)) continue;
      const start = view.getUint16(starts + i * 2);
      if (code < start) return 0;
      const delta = view.getInt16(deltas + i * 2);
      const range = view.getUint16(ranges + i * 2);
      if (!range) return (code + delta) & 0xffff;
      const glyph = view.getUint16(ranges + i * 2 + range + (code - start) * 2);
      return glyph ? (glyph + delta) & 0xffff : 0;
    }
    return 0;
  };
  const glyphFor = (code: number) => {
    let glyph = cache.get(code);
    if (glyph === undefined) {
      glyph = lookup(code);
      if (glyph >= numGlyphs) glyph = 0;
      cache.set(code, glyph);
    }
    return glyph;
  };

  let postScriptName = "Font";
  const name = tables.get("name");
  if (name) {
    const records = view.getUint16(name.offset + 2);
    const strings = name.offset + view.getUint16(name.offset + 4);
    for (let i = 0; i < records; i += 1) {
      const record = name.offset + 6 + i * 12;
      if (view.getUint16(record + 6) !== 6) continue;
      const platform = view.getUint16(record);
      const length = view.getUint16(record + 8);
      const offset = strings + view.getUint16(record + 10);
      let text = "";
      if (platform === 1) for (let k = 0; k < length; k += 1) text += String.fromCharCode(data[offset + k]!);
      else for (let k = 0; k + 1 < length; k += 2) text += String.fromCharCode(view.getUint16(offset + k));
      const clean = text.replace(/[^\x21-\x7e]/g, "").replace(/[[\](){}<>/%]/g, "");
      if (clean) {
        postScriptName = clean;
        break;
      }
    }
  }

  const subset = (wanted: Iterable<number>) => {
    const loca = tables.get("loca");
    const glyf = tables.get("glyf");
    if (cff || !loca || !glyf) return data;
    const glyphOffset = (glyph: number) => (longLoca ? view.getUint32(loca.offset + glyph * 4) : view.getUint16(loca.offset + glyph * 2) * 2);
    // Composite glyphs are built from others, which must come along.
    const keep = new Set<number>([0]);
    const queue = [...wanted].filter((glyph) => glyph >= 0 && glyph < numGlyphs);
    while (queue.length) {
      const glyph = queue.pop()!;
      if (keep.has(glyph) && glyph !== 0) continue;
      keep.add(glyph);
      const start = glyphOffset(glyph);
      const end = glyphOffset(glyph + 1);
      if (end <= start || view.getInt16(glyf.offset + start) >= 0) continue;
      let at = glyf.offset + start + 10;
      for (let guard = 0; guard < 64; guard += 1) {
        const flags = view.getUint16(at);
        const component = view.getUint16(at + 2);
        if (!keep.has(component)) queue.push(component);
        at += 4 + (flags & 1 ? 4 : 2);
        if (flags & 8) at += 2;
        else if (flags & 0x40) at += 4;
        else if (flags & 0x80) at += 8;
        if (!(flags & 0x20)) break;
      }
    }
    const pieces: Uint8Array[] = [];
    const offsets = new Uint32Array(numGlyphs + 1);
    let size = 0;
    for (let glyph = 0; glyph < numGlyphs; glyph += 1) {
      offsets[glyph] = size;
      if (!keep.has(glyph)) continue;
      const start = glyphOffset(glyph);
      const end = glyphOffset(glyph + 1);
      if (end <= start) continue;
      const outline = data.subarray(glyf.offset + start, glyf.offset + end);
      pieces.push(outline);
      size += outline.length;
      // Glyphs start on even offsets.
      if (size % 2) {
        pieces.push(new Uint8Array(1));
        size += 1;
      }
    }
    offsets[numGlyphs] = size;
    const newGlyf = new Uint8Array(size);
    let at = 0;
    for (const piece of pieces) {
      newGlyf.set(piece, at);
      at += piece.length;
    }
    const newLoca = new Uint8Array((numGlyphs + 1) * 4);
    const locaView = new DataView(newLoca.buffer);
    offsets.forEach((offset, index) => locaView.setUint32(index * 4, offset));
    const newHead = data.slice(head.offset, head.offset + head.length);
    new DataView(newHead.buffer).setInt16(50, 1);
    new DataView(newHead.buffer).setUint32(8, 0);
    // A PDF viewer needs only these to draw glyphs by id.
    const kept: Array<[string, Uint8Array]> = [];
    for (const name of ["OS/2", "cvt ", "fpgm", "glyf", "head", "hhea", "hmtx", "loca", "maxp", "name", "post", "prep"]) {
      if (name === "glyf") kept.push([name, newGlyf]);
      else if (name === "loca") kept.push([name, newLoca]);
      else if (name === "head") kept.push([name, newHead]);
      else {
        const table = tables.get(name);
        if (table) kept.push([name, data.subarray(table.offset, table.offset + table.length)]);
      }
    }
    return writeFont(kept);
  };

  return { data, cff, unitsPerEm, ascent, descent, capHeight, italicAngle, bbox, postScriptName, bold, glyphFor, advance, subset };
}

function checksum(bytes: Uint8Array) {
  let sum = 0;
  const padded = bytes.length % 4 ? new Uint8Array(bytes.length + (4 - (bytes.length % 4))) : bytes;
  if (padded !== bytes) padded.set(bytes);
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  for (let i = 0; i < padded.length; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
  return sum;
}

function writeFont(tables: Array<[string, Uint8Array]>) {
  const count = tables.length;
  const headerSize = 12 + count * 16;
  let size = headerSize;
  for (const [, bytes] of tables) size += bytes.length + ((4 - (bytes.length % 4)) % 4);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, count);
  let power = 1;
  let log = 0;
  while (power * 2 <= count) {
    power *= 2;
    log += 1;
  }
  view.setUint16(6, power * 16);
  view.setUint16(8, log);
  view.setUint16(10, count * 16 - power * 16);
  let offset = headerSize;
  let headOffset = -1;
  tables.forEach(([tag, bytes], index) => {
    const record = 12 + index * 16;
    for (let k = 0; k < 4; k += 1) out[record + k] = tag.charCodeAt(k);
    view.setUint32(record + 4, checksum(bytes));
    view.setUint32(record + 8, offset);
    view.setUint32(record + 12, bytes.length);
    out.set(bytes, offset);
    if (tag === "head") headOffset = offset;
    offset += bytes.length + ((4 - (bytes.length % 4)) % 4);
  });
  if (headOffset >= 0) view.setUint32(headOffset + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}

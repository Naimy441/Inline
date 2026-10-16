import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EmbeddedFont } from "@/lib/doc/docxImport";
import { parseTrueType, type TrueTypeFont } from "@/lib/pdf/truetype";
import { dataDir } from "@/lib/server/store";

/**
 * Fonts that came with imported documents. Google Docs and Word carry the
 * fonts a document uses (any that aren't Windows' own) inside the file; they
 * are kept in the data folder, fonts/<id>.<ttf|otf> with fonts/index.json
 * listing them, so the page shows the document in them, and PDFs and Word
 * copies carry them on. One file is kept per family and style: the first a
 * document brought.
 */

export type StoredFont = {
  id: string;
  family: string;
  bold: boolean;
  italic: boolean;
  format: "truetype" | "opentype";
  file: string;
  size: number;
  /**
   * For a font with only some letters (one a PDF carried, cut down to the
   * letters it used): the code points it has, as a CSS unicode-range, and
   * the family whose letters stand in for the rest.
   */
  unicodeRange?: string;
  fallback?: string;
  /** Its height above and below the baseline, in ems (for a font Inline has no figures for). */
  ascent?: number;
  descent?: number;
};

/** A font to keep: one a document brought, perhaps with only some letters. */
export type FontToSave = EmbeddedFont & { fallback?: string; partial?: boolean };

const MAX_FONT_BYTES = 20 * 1024 * 1024;

function fontsDir() {
  return path.join(dataDir(), "fonts");
}

let cache: { mtimeMs: number; fonts: StoredFont[] } | null = null;

export async function listFonts(): Promise<StoredFont[]> {
  const index = path.join(fontsDir(), "index.json");
  const stat = await fs.stat(index).catch(() => null);
  if (!stat) return [];
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.fonts;
  try {
    const parsed = JSON.parse(await fs.readFile(index, "utf8")) as { fonts?: StoredFont[] };
    const fonts = Array.isArray(parsed.fonts) ? parsed.fonts.filter((font) => /^[a-f0-9]{24}$/.test(font.id) && typeof font.family === "string") : [];
    cache = { mtimeMs: stat.mtimeMs, fonts };
    return fonts;
  } catch {
    return [];
  }
}

let writing: Promise<unknown> = Promise.resolve();

/** Keep a font a document brought, unless one of its family and style is kept already. */
export async function saveFont(font: FontToSave): Promise<StoredFont | null> {
  if (!font.family.trim() || font.data.length < 64 || font.data.length > MAX_FONT_BYTES) return null;
  const run = writing.catch(() => undefined).then(async () => {
    const fonts = await listFonts();
    const family = font.family.trim().replace(/\s+/g, " ").slice(0, 100);
    const existing = fonts.find((item) => item.family.toLowerCase() === family.toLowerCase() && item.bold === font.bold && item.italic === font.italic);
    if (existing) return existing;
    const format = String.fromCharCode(...font.data.slice(0, 4)) === "OTTO" ? "opentype" : "truetype";
    const id = createHash("sha256").update(font.data).digest("hex").slice(0, 24);
    const file = `${id}.${format === "opentype" ? "otf" : "ttf"}`;
    await fs.mkdir(fontsDir(), { recursive: true });
    await fs.writeFile(path.join(fontsDir(), file), font.data);
    const parsed = parseTrueType(font.data);
    // Not its space: a PDF's fonts often carry one of any width (TeX's spaces are gaps, not glyphs); the stand-in's is a word space.
    // A font whose letters are all one width (code) keeps a space of that width: a stand-in's would be narrower or wider.
    const range = font.partial && parsed ? unicodeRange(parsed.codePoints().filter((code) => (code !== 0x20 && code !== 0xa0) || monospaceSpace(parsed, code))) : null;
    const stored: StoredFont = {
      id,
      family,
      bold: font.bold,
      italic: font.italic,
      format,
      file,
      size: font.data.length,
      ...(range ? { unicodeRange: range, ...(font.fallback ? { fallback: font.fallback } : {}) } : {}),
      ...(parsed && parsed.unitsPerEm ? { ascent: Math.round((parsed.ascent / parsed.unitsPerEm) * 1000) / 1000, descent: Math.round((Math.abs(parsed.descent) / parsed.unitsPerEm) * 1000) / 1000 } : {}),
    };
    const next = [...fonts, stored];
    const tmp = path.join(fontsDir(), `index.json.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(tmp, JSON.stringify({ fonts: next }), "utf8");
    await fs.rename(tmp, path.join(fontsDir(), "index.json"));
    cache = null;
    return stored;
  });
  writing = run;
  return run;
}

/** Whether a font's space (or no-break space) is one letter wide in a font whose letters are all that wide. */
function monospaceSpace(font: TrueTypeFont, code: number) {
  const space = font.glyphFor(code);
  if (!space) return false;
  const widths = new Set(
    font
      .codePoints()
      .filter((point) => point > 0x20 && point < 0x7f)
      .map((point) => font.glyphFor(point))
      .filter((glyph): glyph is number => Boolean(glyph))
      .map((glyph) => Math.round((font.advance(glyph) / font.unitsPerEm) * 100)),
  );
  return widths.size === 1 && [...widths][0] === Math.round((font.advance(space) / font.unitsPerEm) * 100);
}

/** Code points as a CSS unicode-range: U+41-5A, U+61, … */
export function unicodeRange(codes: number[]) {
  const sorted = [...new Set(codes)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let end = i;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end += 1;
    const hex = (code: number) => code.toString(16).toUpperCase();
    parts.push(end > i ? `U+${hex(sorted[i]!)}-${hex(sorted[end]!)}` : `U+${hex(sorted[i]!)}`);
    i = end + 1;
  }
  return parts.join(", ");
}

export async function readFont(id: string): Promise<{ font: StoredFont; data: Uint8Array } | null> {
  if (!/^[a-f0-9]{24}$/.test(id)) return null;
  const font = (await listFonts()).find((item) => item.id === id);
  if (!font) return null;
  const data = await fs.readFile(path.join(fontsDir(), font.file)).catch(() => null);
  return data ? { font, data: new Uint8Array(data) } : null;
}

/** The kept fonts of these families (any case), for a Word copy or a PDF to carry. */
export async function fontsForFamilies(families: Iterable<string>) {
  const wanted = new Set([...families].map((family) => family.toLowerCase()));
  const fonts = (await listFonts()).filter((font) => wanted.has(font.family.toLowerCase()));
  const loaded = await Promise.all(fonts.map((font) => readFont(font.id)));
  return loaded.filter((item): item is { font: StoredFont; data: Uint8Array } => Boolean(item));
}

/** The kept fonts for a Word copy to carry (lib/doc/docx.ts). */
export async function loadFontsForWord(families: string[]) {
  // A font with only some letters would leave Word without the rest.
  return (await fontsForFamilies(families)).filter(({ font }) => !font.unicodeRange).map(({ font, data }) => ({ family: font.family, bold: font.bold, italic: font.italic, data }));
}

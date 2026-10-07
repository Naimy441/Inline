import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EmbeddedFont } from "@/lib/doc/docxImport";
import { dataDir } from "@/lib/server/store";

/**
 * Fonts that came with imported documents. Google Docs and Word carry the
 * fonts a document uses (any that aren't Windows' own) inside the file; they
 * are kept in the data folder, fonts/<id>.<ttf|otf> with fonts/index.json
 * listing them, so the page shows the document in them, and PDFs and Word
 * copies carry them on. One file is kept per family and style: the first a
 * document brought.
 */

export type StoredFont = { id: string; family: string; bold: boolean; italic: boolean; format: "truetype" | "opentype"; file: string; size: number };

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
export async function saveFont(font: EmbeddedFont): Promise<StoredFont | null> {
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
    const stored: StoredFont = { id, family, bold: font.bold, italic: font.italic, format, file, size: font.data.length };
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
  return (await fontsForFamilies(families)).map(({ font, data }) => ({ family: font.family, bold: font.bold, italic: font.italic, data }));
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { listFonts, saveFont, type StoredFont } from "@/lib/server/fonts";
import type { GoogleFont } from "@/lib/doc/settings";
import { dataDir } from "@/lib/server/store";

/**
 * Google Fonts: every open-source family, to pick from like the built-in
 * fonts. The list comes from Google's own metadata, kept in the data folder
 * for a week (fonts/google.json) so it works offline after the first time.
 * A family is fetched from Google the first time a document uses it and kept
 * with the fonts imported documents brought (lib/server/fonts.ts), so the
 * page, PDFs and Word copies all use the real font from then on.
 */

type GoogleFontCategory = GoogleFont["category"];
export type GoogleFontEntry = GoogleFont & { styles: string[] };

const METADATA_URL = "https://fonts.google.com/metadata/fonts";
const CSS_URL = "https://fonts.googleapis.com/css2";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

const CATEGORIES: Record<string, GoogleFontCategory> = {
  "Sans Serif": "sans-serif",
  Serif: "serif",
  Display: "display",
  Handwriting: "handwriting",
  Monospace: "monospace",
};

type Metadata = {
  familyMetadataList?: Array<{ family?: string; category?: string; fonts?: string[] | Record<string, unknown>; popularity?: number; isOpenSource?: boolean }>;
};

function catalogFile() {
  return path.join(dataDir(), "fonts", "google.json");
}

/** The families in Google's metadata, most popular first. */
export function parseMetadata(metadata: Metadata): GoogleFontEntry[] {
  return (metadata.familyMetadataList ?? [])
    .filter((entry) => typeof entry.family === "string" && entry.family.trim() && entry.isOpenSource !== false)
    .sort((a, b) => (a.popularity ?? Number.MAX_SAFE_INTEGER) - (b.popularity ?? Number.MAX_SAFE_INTEGER))
    .map((entry) => ({
      family: entry.family!.trim(),
      category: CATEGORIES[entry.category ?? ""] ?? "sans-serif",
      styles: Array.isArray(entry.fonts) ? entry.fonts : Object.keys(entry.fonts ?? {}),
    }));
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let memory: { at: number; fonts: GoogleFontEntry[] } | null = null;
let loading: Promise<GoogleFontEntry[]> | null = null;

/** Every Google Fonts family; the copy kept on disk when Google can't be reached; empty when there is neither. */
export async function googleFontCatalog(): Promise<GoogleFontEntry[]> {
  if (memory && Date.now() - memory.at < MAX_AGE_MS) return memory.fonts;
  loading ??= (async () => {
    const stored = await fs
      .readFile(catalogFile(), "utf8")
      .then((raw) => JSON.parse(raw) as { at: number; fonts: GoogleFontEntry[] })
      .catch(() => null);
    if (stored && Array.isArray(stored.fonts) && Date.now() - stored.at < MAX_AGE_MS) {
      memory = stored;
      return stored.fonts;
    }
    try {
      const response = await fetchWithTimeout(METADATA_URL);
      if (!response.ok) throw new Error(`Google Fonts answered ${response.status}.`);
      // The metadata starts with a line that stops it being run as a script.
      const text = (await response.text()).replace(/^\)\]\}'\s*/, "");
      const fonts = parseMetadata(JSON.parse(text) as Metadata);
      if (!fonts.length) throw new Error("Google Fonts listed no families.");
      memory = { at: Date.now(), fonts };
      await fs.mkdir(path.dirname(catalogFile()), { recursive: true });
      await fs.writeFile(catalogFile(), JSON.stringify(memory), "utf8");
      return fonts;
    } catch {
      if (stored?.fonts?.length) {
        memory = { at: Date.now() - MAX_AGE_MS + 60 * 60 * 1000, fonts: stored.fonts };
        return stored.fonts;
      }
      return [];
    }
  })().finally(() => {
    loading = null;
  });
  return loading;
}

export async function findGoogleFont(family: string): Promise<GoogleFontEntry | null> {
  const wanted = family.trim().toLowerCase();
  return (await googleFontCatalog()).find((font) => font.family.toLowerCase() === wanted) ?? null;
}

/** The regular, bold, italic and bold italic styles a family has, as css2's ital,wght pairs; the nearest weights stand in. */
export function stylePairs(styles: string[]): Array<[number, number]> {
  const parsed = styles
    .map((style) => /^(\d{3})(i?)$/.exec(style))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({ weight: Number(match[1]), italic: match[2] === "i" ? 1 : 0 }));
  const pairs: Array<[number, number]> = [];
  for (const italic of [0, 1]) {
    const weights = parsed.filter((style) => style.italic === italic).map((style) => style.weight);
    if (!weights.length) continue;
    const nearest = (target: number) => weights.reduce((best, weight) => (Math.abs(weight - target) < Math.abs(best - target) ? weight : best));
    const regular = nearest(400);
    const bold = nearest(700);
    pairs.push([italic, regular]);
    if (bold > regular) pairs.push([italic, bold]);
  }
  return pairs;
}

/** The @font-face rules of a css2 stylesheet: each style's weight, italic and file. */
export function parseFaces(css: string) {
  const faces: Array<{ weight: number; italic: boolean; url: string }> = [];
  for (const block of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
    const url = /src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\)/.exec(block)?.[1];
    const weight = Number(/font-weight:\s*(\d+)/.exec(block)?.[1] ?? 400);
    if (url) faces.push({ weight, italic: /font-style:\s*italic/.test(block), url });
  }
  return faces;
}

const keeping = new Map<string, Promise<StoredFont[]>>();

/**
 * Fetch a Google Fonts family and keep it with the documents' fonts, unless it is kept already.
 * Resolves to its kept styles; throws when it isn't a Google font or Google can't be reached.
 */
export async function keepGoogleFont(family: string): Promise<StoredFont[]> {
  const font = await findGoogleFont(family);
  if (!font) throw new Error(`"${family}" isn't a Google Fonts family.`);
  const kept = (await listFonts()).filter((item) => item.family.toLowerCase() === font.family.toLowerCase());
  if (kept.length) return kept;
  const key = font.family.toLowerCase();
  let run = keeping.get(key);
  if (!run) {
    run = (async () => {
      const pairs = stylePairs(font.styles);
      if (!pairs.length) throw new Error(`Google Fonts has no styles of ${font.family}.`);
      const query = `${encodeURIComponent(font.family).replace(/%20/g, "+")}:ital,wght@${pairs.map(([italic, weight]) => `${italic},${weight}`).join(";")}`;
      // Without a modern browser's User-Agent Google sends whole TrueType files, which PDFs can embed.
      const response = await fetchWithTimeout(`${CSS_URL}?family=${query}`, { headers: { "User-Agent": "Mozilla/4.0" } });
      if (!response.ok) throw new Error(`Google Fonts couldn't send ${font.family} (${response.status}).`);
      const faces = parseFaces(await response.text());
      if (!faces.length) throw new Error(`Google Fonts sent no files for ${font.family}.`);
      const regular = Math.min(...faces.map((face) => face.weight));
      const saved: StoredFont[] = [];
      for (const face of faces) {
        const file = await fetchWithTimeout(face.url);
        if (!file.ok) continue;
        const stored = await saveFont({ family: font.family, bold: face.weight > regular && face.weight >= 600, italic: face.italic, data: new Uint8Array(await file.arrayBuffer()) });
        if (stored) saved.push(stored);
      }
      if (!saved.length) throw new Error(`Couldn't download ${font.family} from Google Fonts.`);
      return saved;
    })().finally(() => keeping.delete(key));
    keeping.set(key, run);
  }
  return run;
}

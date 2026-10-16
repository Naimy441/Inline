import { lineMetrics, primaryFamily, registerLineMetrics } from "@/lib/doc/fontMetrics";
import { api } from "@/lib/client/api";
import { FONT_FAMILIES, type GoogleFont } from "@/lib/doc/settings";

/**
 * The fonts imported documents brought (lib/server/fonts.ts), made available
 * to the page. Each is sized as Google Docs sizes it (its ascent and descent
 * from lib/doc/fontMetrics.ts), so lines and baselines fall where Google's do.
 */

export type DocumentFont = {
  id: string;
  family: string;
  bold: boolean;
  italic: boolean;
  format: "truetype" | "opentype";
  url: string;
  /** A font with only some letters (a PDF's): the ones it has, and the family the rest come from. */
  unicodeRange?: string;
  fallback?: string | null;
  ascent?: number;
  descent?: number;
};

let listing: Promise<DocumentFont[]> | null = null;
const faces = new Map<string, FontFace>();

/** The kept fonts; `refresh` after an import may have added some. */
export function documentFonts(refresh = false): Promise<DocumentFont[]> {
  if (refresh || !listing) {
    listing = api<{ fonts: DocumentFont[] }>("/api/fonts")
      .then((result) => {
        for (const font of result.fonts) if (font.ascent !== undefined && font.descent !== undefined) registerLineMetrics(font.family, { ascent: font.ascent, descent: font.descent });
        return result.fonts;
      })
      .catch(() => {
        listing = null;
        return [];
      });
  }
  return listing;
}

/** The face of `family` closest to this style. */
export function closestFace<T extends { family: string; bold: boolean; italic: boolean }>(fonts: T[], family: string, bold: boolean, italic: boolean): T | null {
  const candidates = fonts.filter((font) => font.family.toLowerCase() === family.toLowerCase());
  return candidates.find((item) => item.bold === bold && item.italic === italic) ?? candidates.find((item) => item.bold === bold) ?? candidates.find((item) => !item.bold && !item.italic) ?? candidates[0] ?? null;
}

function addFace(font: DocumentFont, all: DocumentFont[]) {
  if (typeof FontFace === "undefined" || typeof document === "undefined") return null;
  const existing = faces.get(font.id);
  if (existing) return existing;
  const metrics = lineMetrics(font.family);
  const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
  const descriptors = {
    weight: font.bold ? "700" : "400",
    style: font.italic ? "italic" : "normal",
    ascentOverride: percent(metrics.ascent),
    descentOverride: percent(metrics.descent),
    lineGapOverride: "0%",
  };
  // A font with only some letters: the others come from its stand-in, added under its family first,
  // since of two faces that both have a letter the one added last draws it.
  if (font.unicodeRange) {
    const standIn = font.fallback ? closestFace(all, font.fallback, font.bold, font.italic) : null;
    const source = standIn ? `url(${standIn.url})` : font.fallback ? `local("${font.fallback.replace(/"/g, "")}")` : null;
    if (source) {
      const rest = new FontFace(font.family, source, descriptors);
      document.fonts.add(rest);
      void rest.load().catch(() => undefined);
    }
  }
  const face = new FontFace(font.family, `url(${font.url})`, font.unicodeRange ? { ...descriptors, unicodeRange: font.unicodeRange } : descriptors);
  document.fonts.add(face);
  faces.set(font.id, face);
  return face;
}

/**
 * Make every kept font available, and wait (a few seconds at most) for those
 * the given text names, so the first layout is already in them.
 */
export async function loadDocumentFonts(used: string, refresh = false) {
  const fonts = await documentFonts(refresh);
  const lower = used.toLowerCase();
  const loading: Promise<unknown>[] = [];
  for (const font of fonts) {
    const face = addFace(font, fonts);
    if (face && lower.includes(font.family.toLowerCase())) loading.push(face.load().catch(() => undefined));
  }
  if (!loading.length) return;
  await Promise.race([Promise.all(loading), new Promise((resolve) => setTimeout(resolve, 4000))]);
}

// --- Google Fonts (lib/server/googleFonts.ts) ------------------------------------------------

let catalog: Promise<GoogleFont[]> | null = null;

/** Every Google Fonts family, most popular first; empty when the list can't be had. */
export function googleFonts(): Promise<GoogleFont[]> {
  catalog ??= api<{ fonts: GoogleFont[] }>("/api/fonts/google")
    .then((result) => result.fonts)
    .catch(() => {
      catalog = null;
      return [];
    });
  return catalog;
}

const ensuring = new Map<string, Promise<boolean>>();

/**
 * The CSS font-family for a font kept from an import: the family itself, then
 * the stand-in its missing letters come from (a PDF subset), or a generic of
 * the same kind.
 */
export function savedFontValue(family: string, fallback?: string | null): string {
  const name = family.replace(/"/g, "").trim();
  const quoted = `"${name}"`;
  const standIn = fallback?.replace(/"/g, "").trim();
  if (standIn && standIn.toLowerCase() !== name.toLowerCase()) {
    const known = FONT_FAMILIES.find((font) => font.label.toLowerCase() === standIn.toLowerCase());
    return known ? `${quoted}, ${known.value}` : `${quoted}, "${standIn}", sans-serif`;
  }
  const generic = /mono|courier|typewriter|menlo|consolas/i.test(name) ? "monospace" : /serif|times|roman|garamond|georgia|cambria|book/i.test(name) && !/sans/i.test(name) ? "serif" : "sans-serif";
  return `${quoted}, ${generic}`;
}

/** One menu row per kept family. `skip` is families the menu already lists (the standard fonts, Google's). */
export function savedFontChoices(fonts: Array<Pick<DocumentFont, "family" | "fallback">>, skip: Iterable<string> = []): Array<{ label: string; value: string }> {
  const taken = new Set([...skip].map((name) => name.toLowerCase()));
  const byFamily = new Map<string, { family: string; fallback?: string | null }>();
  for (const font of fonts) {
    const family = font.family.trim();
    const key = family.toLowerCase();
    if (!key || taken.has(key) || byFamily.has(key)) continue;
    byFamily.set(key, font);
  }
  return [...byFamily.values()]
    .sort((a, b) => a.family.localeCompare(b.family, undefined, { sensitivity: "base" }))
    .map((font) => ({ label: font.family, value: savedFontValue(font.family, font.fallback) }));
}

/**
 * Make sure each of these font families (CSS font-family values) is on the page: a font the
 * library already has (one an import brought, shared by every document) is loaded, and a Google
 * Fonts family the server hasn't kept yet is fetched and kept. Resolves to whether any font was added.
 */
export async function ensureFonts(values: Iterable<string>): Promise<boolean> {
  const families = [...new Set([...values].map((value) => primaryFamily(value)).filter(Boolean))];
  if (!families.length) return false;
  const fonts = await documentFonts();
  const kept = new Set(fonts.map((font) => font.family.toLowerCase()));
  const present = families.filter((family) => kept.has(family.toLowerCase()));
  // A font kept from another document is not on this page until its face is loaded.
  if (present.length) await loadDocumentFonts(present.join("\n"));
  const missing = families.filter((family) => !kept.has(family.toLowerCase()));
  if (!missing.length) return false;
  const google = new Map((await googleFonts()).map((font) => [font.family.toLowerCase(), font.family]));
  const results = await Promise.all(
    missing
      .map((family) => google.get(family.toLowerCase()))
      .filter((family): family is string => Boolean(family))
      .map((family) => {
        const key = family.toLowerCase();
        let run = ensuring.get(key);
        if (!run) {
          run = api("/api/fonts/google", { method: "POST", json: { family } })
            .then(() => true)
            .catch(() => {
              ensuring.delete(key);
              return false;
            });
          ensuring.set(key, run);
        }
        return run;
      }),
  );
  if (!results.some(Boolean)) return false;
  await loadDocumentFonts(families.join(" "), true);
  return true;
}

const previews = new Set<string>();

/** Show a family's name in its own face in a font picker: Google sends just those letters. */
export function previewFont(family: string) {
  if (typeof document === "undefined" || previews.has(family)) return;
  previews.add(family);
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}&text=${encodeURIComponent(family)}&display=swap`;
  // Renamed: these faces hold only the name's letters, so under the family's own name they could stand in for the whole font.
  void fetch(url)
    .then((response) => (response.ok ? response.text() : ""))
    .then((css) => {
      if (!css) return;
      const style = document.createElement("style");
      style.textContent = css.replace(/font-family:\s*['"]?[^;'"]+['"]?;/g, `font-family: "${previewFamily(family)}";`);
      document.head.append(style);
    })
    .catch(() => undefined);
}

/** The family a Google font's name-only preview (previewFont) is loaded as. */
export function previewFamily(family: string) {
  return `Inline preview ${family}`;
}

/** A kept font's data, for a PDF to embed. */
export async function fontData(font: DocumentFont): Promise<Uint8Array | null> {
  try {
    const response = await fetch(font.url);
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

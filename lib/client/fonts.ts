import { lineMetrics } from "@/lib/doc/fontMetrics";
import { api } from "@/lib/client/api";

/**
 * The fonts imported documents brought (lib/server/fonts.ts), made available
 * to the page. Each is sized as Google Docs sizes it (its ascent and descent
 * from lib/doc/fontMetrics.ts), so lines and baselines fall where Google's do.
 */

export type DocumentFont = { id: string; family: string; bold: boolean; italic: boolean; format: "truetype" | "opentype"; url: string };

let listing: Promise<DocumentFont[]> | null = null;
const faces = new Map<string, FontFace>();

/** The kept fonts; `refresh` after an import may have added some. */
export function documentFonts(refresh = false): Promise<DocumentFont[]> {
  if (refresh || !listing) {
    listing = api<{ fonts: DocumentFont[] }>("/api/fonts")
      .then((result) => result.fonts)
      .catch(() => {
        listing = null;
        return [];
      });
  }
  return listing;
}

function addFace(font: DocumentFont) {
  if (typeof FontFace === "undefined" || typeof document === "undefined") return null;
  const existing = faces.get(font.id);
  if (existing) return existing;
  const metrics = lineMetrics(font.family);
  const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
  const face = new FontFace(font.family, `url(${font.url})`, {
    weight: font.bold ? "700" : "400",
    style: font.italic ? "italic" : "normal",
    ascentOverride: percent(metrics.ascent),
    descentOverride: percent(metrics.descent),
    lineGapOverride: "0%",
  });
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
    const face = addFace(font);
    if (face && lower.includes(font.family.toLowerCase())) loading.push(face.load().catch(() => undefined));
  }
  if (!loading.length) return;
  await Promise.race([Promise.all(loading), new Promise((resolve) => setTimeout(resolve, 4000))]);
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

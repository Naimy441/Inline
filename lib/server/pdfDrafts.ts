import { primaryFamily } from "@/lib/doc/fontMetrics";
import { pageSize } from "@/lib/doc/settings";
import { draftPage, type PageDraft } from "@/lib/pdf/import/draft";
import type { PdfBox } from "@/lib/pdf/import/types";
import { parseTrueType, type TrueTypeFont } from "@/lib/pdf/truetype";
import type { LiveDocument } from "@/lib/server/hub";
import { log } from "@/lib/server/log";
import { cropRegion, readUpload, writePdfImport, type PdfImportRecord } from "@/lib/server/pdfImports";

/**
 * Drafts of an imported PDF's pages (lib/pdf/import/draft.ts), for Claude
 * to start each page from: made from the import's analysis and the
 * document's settings, with the PDF's drawings, and any equations that
 * can't be read back, cut out of the page as pictures (once; kept with the
 * import).
 */

const parsed = new Map<string, TrueTypeFont | null>();

async function fontOf(url: string) {
  if (parsed.has(url)) return parsed.get(url)!;
  const data = await readUpload(url).catch(() => null);
  const font = data ? parseTrueType(data) : null;
  parsed.set(url, font);
  while (parsed.size > 64) parsed.delete(parsed.keys().next().value!);
  return font;
}

const sameBox = (a: PdfBox, b: PdfBox) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

export async function pageDraft(doc: LiveDocument, record: PdfImportRecord, number: number): Promise<PageDraft> {
  const page = record.manifest.pages[number - 1];
  const assets = record.pages[number - 1];
  if (!page || !assets) throw new Error(`The PDF has no page ${number}.`);
  const settings = doc.meta.settings;
  const { margins } = settings.pageSetup;
  const size = pageSize(settings.pageSetup);
  const area = { left: margins.left * 72, top: margins.top * 72, width: (size.width - margins.left - margins.right) * 72 };

  // The letters' widths, from the PDF's own fonts.
  const fonts = new Map<string, TrueTypeFont>();
  for (const [name, url] of Object.entries(record.fontFiles ?? {})) {
    const font = await fontOf(url);
    if (font) fonts.set(name, font);
  }
  const advance = (name: string, char: string) => {
    const font = fonts.get(name);
    const glyph = font?.glyphFor(char.codePointAt(0)!);
    return font && glyph ? font.advance(glyph) / font.unitsPerEm : null;
  };

  let changed = false;
  // Drawings cut out as pictures, with room for their labels.
  if (!assets.crops) {
    assets.crops = [];
    for (const box of page.graphics) {
      const padded = { x: Math.max(0, box.x - 6), y: Math.max(0, box.y - 6), width: box.width + 12, height: box.height + 12 };
      const crop = await cropRegion(record, number, padded).catch((error) => {
        log("warn", "a PDF drawing couldn't be cut out", { page: number, error });
        return null;
      });
      if (crop) assets.crops.push({ box: padded, url: crop.url });
    }
    changed = true;
  }

  const make = () =>
    draftPage({
      page,
      summary: record.manifest.summary,
      area,
      fontSize: settings.fontSize,
      lineSpacing: settings.lineSpacing,
      family: record.fonts?.[record.manifest.summary.bodyFont]?.family ?? primaryFamily(settings.fontFamily),
      fonts: record.fonts ?? {},
      crops: assets.crops ?? [],
      advance,
      cropFor: (box) => assets.equations?.find((item) => sameBox(item.box, box))?.url ?? null,
    });
  let draft = make();
  if (draft.needs.length) {
    assets.equations ??= [];
    for (const box of draft.needs) {
      const crop = await cropRegion(record, number, box).catch(() => null);
      if (crop) assets.equations.push({ box, url: crop.url });
    }
    changed = true;
    draft = make();
  }
  if (changed) await writePdfImport(record);
  return draft;
}

import { z } from "zod";
import { HttpError, json, readJson, route } from "@/lib/server/http";
import { googleFontCatalog, keepGoogleFont } from "@/lib/server/googleFonts";

/** Every Google Fonts family, most popular first, to pick from. */
export const GET = route(async () => {
  const fonts = await googleFontCatalog();
  return json({ fonts: fonts.map(({ family, category }) => ({ family, category })) }, { headers: { "Cache-Control": "private, max-age=3600" } });
});

/** Fetch a Google Fonts family and keep it with the documents' fonts (GET /api/fonts lists them). */
export const POST = route(async (request) => {
  const { family } = await readJson(request, z.object({ family: z.string().min(1).max(100) }));
  try {
    const fonts = await keepGoogleFont(family);
    return json({ fonts: fonts.map((font) => ({ id: font.id, family: font.family, bold: font.bold, italic: font.italic })) });
  } catch (error) {
    throw new HttpError(502, error instanceof Error ? error.message : "Couldn't fetch that font from Google Fonts.");
  }
});

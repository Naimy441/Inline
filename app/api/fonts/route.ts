import { json, route } from "@/lib/server/http";
import { listFonts } from "@/lib/server/fonts";

/** The fonts imported documents brought (lib/server/fonts.ts), for the page to load. */
export const GET = route(async () => {
  const fonts = await listFonts();
  return json({ fonts: fonts.map((font) => ({ id: font.id, family: font.family, bold: font.bold, italic: font.italic, format: font.format, url: `/api/fonts/${font.file}` })) });
});

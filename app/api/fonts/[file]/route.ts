import { notFound, route } from "@/lib/server/http";
import { readFont } from "@/lib/server/fonts";

type Context = { params: Promise<{ file: string }> };

export const GET = route(async (_request, context: Context) => {
  const { file } = await context.params;
  const found = await readFont(file.replace(/\.(ttf|otf)$/, ""));
  if (!found) throw notFound("Font not found.");
  return new Response(found.data as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": found.font.format === "opentype" ? "font/otf" : "font/ttf",
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

import { HttpError, json, notFound, route, routeDocument } from "@/lib/server/http";
import { readThumbnail, writeThumbnail } from "@/lib/server/store";

type Context = { params: Promise<{ id: string }> };

const MAX_BYTES = 300 * 1024;

function imageType(data: Uint8Array) {
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (String.fromCharCode(...data.slice(0, 4)) === "RIFF" && String.fromCharCode(...data.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

const themeOf = (request: Request) => (new URL(request.url).searchParams.get("theme") === "dark" ? "dark" : "light");

/** The document's first page as a small image, for the home page. ?theme=dark asks for the dark theme's (the light one if there is none yet). */
export const GET = route(async (request, context: Context) => {
  const doc = await routeDocument(context, { allowTrashed: true });
  const data = (themeOf(request) === "dark" ? await readThumbnail(doc.id, "dark") : null) ?? (await readThumbnail(doc.id));
  const type = data && imageType(data);
  if (!data || !type) throw notFound("No thumbnail yet.");
  return new Response(data as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": type,
      // Pages ask with ?v=<thumbnailAt>, so each version can be cached for good.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

/** The editor saves a new thumbnail when the first page changes: the dark one (?theme=dark), then the light one, whose ?key= names what it shows. */
export const PUT = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const data = new Uint8Array(await request.arrayBuffer());
  if (data.length > MAX_BYTES) throw new HttpError(413, "Thumbnails can be up to 300 KB.");
  if (!imageType(data)) throw new HttpError(415, "Send a WebP or JPEG image.");
  if (themeOf(request) === "dark") {
    await writeThumbnail(doc.id, data, "dark");
    return json({ ok: true });
  }
  await writeThumbnail(doc.id, data);
  doc.setThumbnail((new URL(request.url).searchParams.get("key") ?? "").slice(0, 64));
  return json({ thumbnailAt: doc.meta.thumbnailAt });
});

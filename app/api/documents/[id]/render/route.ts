import { HttpError, json, route, routeDocument } from "@/lib/server/http";
import { deliverPageRenders, type RenderedBlock, type RenderedLine, type RenderedPage } from "@/lib/server/renders";

type Context = { params: Promise<{ id: string }> };

const MAX_BYTES = 20 * 1024 * 1024;

/** The editor's pictures of pages Claude asked to see (lib/server/renders.ts): "requestId", and "page-N" PNGs. */
export const POST = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const form = await request.formData().catch(() => null);
  const requestId = form?.get("requestId");
  if (typeof requestId !== "string" || !requestId) throw new HttpError(400, 'Send the request\'s id as "requestId".');
  const pages: RenderedPage[] = [];
  let total = 0;
  for (const [name, value] of form!.entries()) {
    const match = /^page-(\d+)$/.exec(name);
    if (!match || !(value instanceof Blob)) continue;
    const png = new Uint8Array(await value.arrayBuffer());
    total += png.length;
    if (total > MAX_BYTES) throw new HttpError(413, "The pictures are too large.");
    if (png[0] !== 0x89 || png[1] !== 0x50) throw new HttpError(415, "Send PNG pictures.");
    const raw = form!.get(`lines-${match[1]}`);
    let lines: RenderedLine[] | undefined;
    try {
      const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(parsed)) lines = parsed.filter((line): line is RenderedLine => Boolean(line) && typeof line.text === "string" && Number.isFinite(line.x) && Number.isFinite(line.y)).slice(0, 2000);
    } catch {
      lines = undefined;
    }
    let blocks: RenderedBlock[] | undefined;
    try {
      const raw = form!.get(`blocks-${match[1]}`);
      const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(parsed)) blocks = parsed.filter((block): block is RenderedBlock => Boolean(block) && typeof block.id === "string" && Number.isFinite(block.top) && Number.isFinite(block.bottom)).slice(0, 2000);
    } catch {
      blocks = undefined;
    }
    pages.push({ page: Number(match[1]), png, ...(lines ? { lines } : {}), ...(blocks ? { blocks } : {}) });
  }
  // The pages a requested run of blocks takes, on the first page pictured.
  const spanRaw = form!.get("span");
  let span: { first: number; last: number } | null = null;
  try {
    const parsed = typeof spanRaw === "string" ? (JSON.parse(spanRaw) as { first?: unknown; last?: unknown }) : null;
    if (parsed && Number.isInteger(parsed.first) && Number.isInteger(parsed.last)) span = { first: Number(parsed.first), last: Number(parsed.last) };
  } catch {
    span = null;
  }
  const ordered = span ? pages : pages.sort((a, b) => a.page - b.page);
  if (span && ordered[0]) ordered[0] = { ...ordered[0], span };
  return json({ delivered: deliverPageRenders(doc.id, requestId, ordered) });
});

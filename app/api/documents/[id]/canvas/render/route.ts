import { HttpError, route, routeDocument } from "@/lib/server/http";
import { renderCanvas } from "@/lib/server/canvasRender";

export const GET = route(async (request, context: { params: Promise<{ id: string }> }) => {
  const doc = await routeDocument(context);
  const query = new URL(request.url).searchParams;
  const page = Number(query.get("page") || "1");
  if (!Number.isInteger(page) || page < 1) throw new HttpError(400, "Choose a positive page number.");
  if (query.has("epoch") && (query.get("epoch") !== doc.epoch || Number(query.get("version")) !== doc.version)) throw new HttpError(409, "The Canvas changed before its page could be captured. Try again.");
  const result = await renderCanvas(doc, { page });
  return new Response(new Uint8Array(result.png!), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Inline-Pages": String(result.report.pages), "X-Inline-Version": String(result.report.version), "X-Inline-Epoch": result.report.epoch } });
});

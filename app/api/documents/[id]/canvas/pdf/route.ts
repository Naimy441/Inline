import { route, routeDocument } from "@/lib/server/http";
import { renderCanvas } from "@/lib/server/canvasRender";

export const GET = route(async (_request, context: { params: Promise<{ id: string }> }) => {
  const doc = await routeDocument(context);
  const rendered = await renderCanvas(doc, { pdf: true });
  return new Response(new Uint8Array(rendered.pdf!), { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.meta.title)}.pdf` } });
});

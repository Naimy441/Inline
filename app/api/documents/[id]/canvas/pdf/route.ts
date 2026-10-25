import { route, routeDocument } from "@/lib/server/http";
import { renderCanvas } from "@/lib/server/canvasRender";
import { exportUnrestrictedPdf } from "@/lib/server/unrestrictedRender";

export const GET = route(async (_request, context: { params: Promise<{ id: string }> }) => {
  const doc = await routeDocument(context);
  const pdf = doc.doc.attrs.canvas?.format === 2 ? await exportUnrestrictedPdf(doc) : (await renderCanvas(doc, { pdf: true })).pdf!;
  return new Response(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.meta.title)}.pdf` } });
});

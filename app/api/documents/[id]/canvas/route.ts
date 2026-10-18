import { z } from "zod";
import { route, routeDocument, json, readJson } from "@/lib/server/http";
import { canvasTransform, readCanvas } from "@/lib/canvas/operations";
import { canvasPatchShape } from "@/lib/agent/canvasTools";

type Context = { params: Promise<{ id: string }> };
export const GET = route(async (_request, context: Context) => json(readCanvas(await routeDocument(context))));
export const PATCH = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const patch = await readJson(request, z.object(canvasPatchShape));
  doc.applyTransform(canvasTransform(doc, patch).tr, { kind: "system", label: "canvas-design" });
  return json(readCanvas(doc));
});

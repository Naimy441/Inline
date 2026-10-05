import { json, route, routeDocument } from "@/lib/server/http";
import { documentHub } from "@/lib/server/hub";

type Context = { params: Promise<{ id: string }> };

export const POST = route(async (_request, context: Context) => {
  const doc = await routeDocument(context);
  const copy = await documentHub().duplicate(doc.id);
  return json({ document: copy.snapshot() }, { status: 201 });
});

import { z } from "zod";
import { json, readJson, route, routeDocument } from "@/lib/server/http";

type Context = { params: Promise<{ id: string }> };

const Body = z.object({
  action: z.enum(["accept", "reject"]),
  ids: z.union([z.literal("all"), z.array(z.string().max(80)).min(1)]),
});

export const POST = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const body = await readJson(request, Body);
  doc.review(body.action, body.ids);
  return json({ version: doc.version, hunks: doc.hunksJSON() });
});

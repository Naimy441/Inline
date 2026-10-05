import { z } from "zod";
import { json, readJson, route, routeDocument } from "@/lib/server/http";

type Context = { params: Promise<{ id: string }> };

export const GET = route(async (_request, context: Context) => {
  const doc = await routeDocument(context);
  return json({ versions: await doc.versions() });
});

const Body = z.object({ label: z.string().trim().max(120).optional() });

export const POST = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const body = await readJson(request, Body);
  const version = await doc.saveVersion(body.label || "Saved version", "user");
  return json({ version }, { status: 201 });
});

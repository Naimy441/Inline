import { z } from "zod";
import { json, readJson, route, routeDocument } from "@/lib/server/http";

type Context = { params: Promise<{ id: string; versionId: string }> };

const Body = z.object({ discard: z.boolean().optional() }).optional();

export const POST = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const { versionId } = await context.params;
  const body = await readJson(request, Body);
  const version = await doc.restoreVersion(versionId, { discard: body?.discard });
  doc.noteUserEvent(`restored an earlier version of the document ("${version.label}", saved ${new Date(version.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })})`);
  return json({ version, document: doc.snapshot() });
});

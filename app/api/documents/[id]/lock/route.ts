import { z } from "zod";
import { HttpError, json, readJson, route, routeDocument } from "@/lib/server/http";

type Context = { params: Promise<{ id: string }> };

const Body = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(1),
  version: z.number().int().min(0),
  locked: z.boolean(),
});

/** Lock a range of text from Claude's edits, or unlock it. */
export const POST = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const body = await readJson(request, Body);
  if (body.version !== doc.version) throw new HttpError(409, "Version conflict.", { version: doc.version });
  if (body.to <= body.from || body.to > doc.doc.content.size) throw new HttpError(400, "Invalid range.");
  const changed = doc.setLocked(body.from, body.to, body.locked);
  return json({ changed, version: doc.version });
});

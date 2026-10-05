import { z } from "zod";
import { json, readJson, route, routeDocument } from "@/lib/server/http";

type Context = { params: Promise<{ id: string }> };

const Body = z.object({
  version: z.number().int().min(0),
  steps: z.array(z.unknown()).min(1).max(5000),
  clientID: z.string().min(1).max(80),
  suggest: z.boolean().optional(),
  epoch: z.string().max(40).optional(),
});

/** prosemirror-collab: accept steps based on the current version, or 409 with the version to catch up to. */
export const POST = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const body = await readJson(request, Body);
  const version = doc.receiveClientSteps(body.version, body.steps, body.clientID, { suggest: body.suggest, epoch: body.epoch });
  return json({ version });
});

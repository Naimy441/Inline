import { z } from "zod";
import { isUserSuggestion } from "@/lib/doc/review";
import { json, readJson, route, routeDocument } from "@/lib/server/http";

type Context = { params: Promise<{ id: string }> };

const Body = z.object({
  action: z.enum(["accept", "reject"]),
  ids: z.union([z.literal("all"), z.array(z.string().max(80)).min(1)]),
});

export const POST = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const body = await readJson(request, Body);
  const undone = body.action === "reject" ? doc.hunks.filter((hunk) => !isUserSuggestion(hunk) && (body.ids === "all" || body.ids.includes(hunk.id))).length : 0;
  doc.review(body.action, body.ids);
  if (undone) doc.noteUserEvent(`undid ${undone} of your pending change${undone === 1 ? "" : "s"}`);
  return json({ version: doc.version, hunks: doc.hunksJSON() });
});

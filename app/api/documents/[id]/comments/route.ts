import { z } from "zod";
import { HttpError, json, readJson, route, routeDocument } from "@/lib/server/http";

type Context = { params: Promise<{ id: string }> };

export const GET = route(async (_request, context: Context) => {
  const doc = await routeDocument(context);
  return json({ comments: doc.commentsWithAnchors() });
});

const Body = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(1),
  version: z.number().int().min(0),
  body: z.string().trim().min(1).max(10_000),
});

export const POST = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const body = await readJson(request, Body);
  if (body.version !== doc.version) throw new HttpError(409, "Version conflict.", { version: doc.version });
  if (body.to <= body.from || body.to > doc.doc.content.size) throw new HttpError(400, "Invalid comment range.");
  const comment = doc.addComment({ from: body.from, to: body.to, body: body.body, author: "user" }, { kind: "system", label: "comment" });
  return json({ comment, version: doc.version }, { status: 201 });
});

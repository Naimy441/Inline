import { z } from "zod";
import { json, notFound, readJson, route, routeDocument } from "@/lib/server/http";

type Context = { params: Promise<{ id: string; commentId: string }> };

const Body = z.object({ body: z.string().trim().min(1).max(10_000) });

export const POST = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const { commentId } = await context.params;
  if (!doc.comments.some((comment) => comment.id === commentId)) throw notFound("Comment not found.");
  const body = await readJson(request, Body);
  const reply = doc.replyToComment(commentId, body.body, "user");
  return json({ reply }, { status: 201 });
});

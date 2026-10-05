import { z } from "zod";
import { json, notFound, readJson, route, routeDocument } from "@/lib/server/http";

type Context = { params: Promise<{ id: string; commentId: string }> };

const Body = z.object({ body: z.string().trim().min(1).max(10_000).optional(), resolved: z.boolean().optional() });

export const PATCH = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const { commentId } = await context.params;
  if (!doc.comments.some((comment) => comment.id === commentId)) throw notFound("Comment not found.");
  const body = await readJson(request, Body);
  if (body.body !== undefined) doc.editComment(commentId, body.body);
  if (body.resolved !== undefined) doc.setCommentResolved(commentId, body.resolved);
  return json({ comments: doc.comments });
});

export const DELETE = route(async (_request, context: Context) => {
  const doc = await routeDocument(context);
  const { commentId } = await context.params;
  doc.deleteComment(commentId);
  return json({ comments: doc.comments });
});

import { z } from "zod";
import { routeChat, type ChatContext } from "@/lib/agent/routes";
import { documentHub } from "@/lib/server/hub";
import { json, notFound, readJson, route } from "@/lib/server/http";

const Body = z.object({
  /** The reply to rewind to before: it, the message that asked for it and everything after are removed. */
  messageId: z.string().max(80),
  /** Also put this document back to this version (the one saved before the reply's edits). */
  documentId: z.string().max(80).optional(),
  versionId: z.string().max(80).optional(),
});

/** "Restore to before": put the document back and rewind the chat, so Claude forgets the undone turns too. */
export const POST = route(async (request, context: ChatContext) => {
  const chat = await routeChat(context);
  const body = await readJson(request, Body);
  const doc = body.documentId && body.versionId ? await documentHub().get(body.documentId) : null;
  if (body.versionId && !doc) throw notFound("Document not found.");
  const removed = await chat.rewind(body.messageId);
  if (doc && body.versionId) {
    const version = await doc.restoreVersion(body.versionId);
    doc.noteUserEvent(`restored the document to "${version.label}" and rewound this chat to before that reply`);
  }
  return json({ text: removed?.text ?? "" });
});

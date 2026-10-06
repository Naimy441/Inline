import { z } from "zod";
import { ClientIdSchema, SendSchema, SettingsPatchSchema } from "@/lib/agent/schemas";
import { agentRuntime } from "@/lib/agent/runtime";
import { HttpError, json, readJson, route } from "@/lib/server/http";

export const GET = route(async (request) => {
  const documentId = new URL(request.url).searchParams.get("documentId") ?? undefined;
  return json({ chats: await agentRuntime().list({ documentId }) });
});

const CreateBody = z.object({
  /** Chosen by the panel, so it can show the chat before this returns. Creating the same id again returns that chat. */
  id: ClientIdSchema.optional(),
  documentId: z.string().max(80).nullable().optional(),
  settings: SettingsPatchSchema.optional(),
  /** Start Claude Code now, ahead of the first message. */
  warm: z.boolean().optional(),
  /** The first message, sent in the same request. */
  message: SendSchema.optional(),
});

export const POST = route(async (request) => {
  const body = await readJson(request, CreateBody);
  if (body.message && !body.message.text.trim() && !body.message.attachments?.length) throw new HttpError(400, "Message is empty.");
  const runtime = agentRuntime();
  if (body.settings) runtime.setDefaults(stripUndefined(body.settings));
  const chat = await runtime.create({ id: body.id, documentId: body.documentId ?? null, settings: stripUndefined(body.settings ?? {}) });
  if (body.message) await chat.send(body.message);
  else if (body.warm) chat.warm();
  return json({ chat: chat.state }, { status: 201 });
});

function stripUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}

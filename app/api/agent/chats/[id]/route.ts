import { z } from "zod";
import { routeChat, type ChatContext } from "@/lib/agent/routes";
import { agentRuntime } from "@/lib/agent/runtime";
import { SettingsPatchSchema } from "@/lib/agent/schemas";
import { json, readJson, route } from "@/lib/server/http";

export const GET = route(async (_request, context: ChatContext) => {
  const chat = await routeChat(context);
  return json({ chat: chat.state });
});

const PatchBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  documentId: z.string().max(80).nullable().optional(),
  settings: SettingsPatchSchema.optional(),
});

export const PATCH = route(async (request, context: ChatContext) => {
  const chat = await routeChat(context);
  const body = await readJson(request, PatchBody);
  const settings = body.settings ? Object.fromEntries(Object.entries(body.settings).filter(([, value]) => value !== undefined)) : undefined;
  await chat.update({ title: body.title, documentId: body.documentId, settings });
  // New chats start with the settings last chosen.
  if (settings) agentRuntime().setDefaults(settings);
  return json({ chat: chat.state });
});

export const DELETE = route(async (_request, context: ChatContext) => {
  const chat = await routeChat(context);
  await agentRuntime().remove(chat.state.id);
  return json({ ok: true });
});

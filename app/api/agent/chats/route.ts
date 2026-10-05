import { z } from "zod";
import { SettingsPatchSchema } from "@/lib/agent/schemas";
import { agentRuntime } from "@/lib/agent/runtime";
import { json, readJson, route } from "@/lib/server/http";

export const GET = route(async (request) => {
  const documentId = new URL(request.url).searchParams.get("documentId") ?? undefined;
  return json({ chats: await agentRuntime().list({ documentId }) });
});

const CreateBody = z.object({
  documentId: z.string().max(80).nullable().optional(),
  settings: SettingsPatchSchema.optional(),
});

export const POST = route(async (request) => {
  const body = await readJson(request, CreateBody);
  const runtime = agentRuntime();
  if (body.settings) runtime.setDefaults(stripUndefined(body.settings));
  const chat = await runtime.create({ documentId: body.documentId ?? null, settings: stripUndefined(body.settings ?? {}) });
  return json({ chat: chat.state }, { status: 201 });
});

function stripUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}

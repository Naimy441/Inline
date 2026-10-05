import { agentRuntime } from "@/lib/agent/runtime";
import { notFound } from "@/lib/server/http";

export type ChatContext = { params: Promise<{ id: string }> };

export async function routeChat(context: ChatContext) {
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw notFound("Chat not found.");
  const chat = await agentRuntime().get(id);
  if (!chat) throw notFound("Chat not found.");
  return chat;
}

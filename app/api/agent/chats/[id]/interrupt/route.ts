import { routeChat, type ChatContext } from "@/lib/agent/routes";
import { json, route } from "@/lib/server/http";

export const POST = route(async (_request, context: ChatContext) => {
  const chat = await routeChat(context);
  await chat.interrupt();
  return json({ ok: true });
});

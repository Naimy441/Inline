import { routeChat, type ChatContext } from "@/lib/agent/routes";
import { json, route } from "@/lib/server/http";

/** Start the chat's Claude Code session ahead of the next message (the user is typing). */
export const POST = route(async (_request, context: ChatContext) => {
  const chat = await routeChat(context);
  return json({ started: chat.warm() });
});

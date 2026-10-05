import { routeChat } from "@/lib/agent/routes";
import { json, route } from "@/lib/server/http";

type Context = { params: Promise<{ id: string; queueId: string }> };

export const DELETE = route(async (_request, context: Context) => {
  const chat = await routeChat(context);
  const { queueId } = await context.params;
  chat.removeQueued(queueId);
  return json({ queue: chat.state.queue });
});

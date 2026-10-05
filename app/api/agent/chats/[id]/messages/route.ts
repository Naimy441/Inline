import { routeChat, type ChatContext } from "@/lib/agent/routes";
import { SendSchema } from "@/lib/agent/schemas";
import { json, readJson, route } from "@/lib/server/http";

/** Send a message. It starts a turn now, or is queued behind the running one. */
export const POST = route(async (request, context: ChatContext) => {
  const chat = await routeChat(context);
  const body = await readJson(request, SendSchema);
  const result = await chat.send(body);
  return json(result, { status: 202 });
});

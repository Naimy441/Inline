import { routeChat, type ChatContext } from "@/lib/agent/routes";
import { SendSchema } from "@/lib/agent/schemas";
import { HttpError, json, readJson, route } from "@/lib/server/http";

/** Send a message. It starts a turn now, or is queued behind the running one. */
export const POST = route(async (request, context: ChatContext) => {
  const chat = await routeChat(context);
  const body = await readJson(request, SendSchema);
  if (!body.text.trim() && !body.attachments?.length) throw new HttpError(400, "Message is empty.");
  const result = await chat.send(body);
  return json(result, { status: 202 });
});

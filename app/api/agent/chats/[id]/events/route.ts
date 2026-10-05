import { routeChat, type ChatContext } from "@/lib/agent/routes";
import { route, sse } from "@/lib/server/http";

/** Live chat stream. Reconnecting clients pass ?after=<last seq> (or Last-Event-ID) to resume without gaps. */
export const GET = route(async (request, context: ChatContext) => {
  const chat = await routeChat(context);
  const raw = new URL(request.url).searchParams.get("after") ?? request.headers.get("last-event-id");
  const after = raw != null && raw !== "" && Number.isInteger(Number(raw)) ? Number(raw) : undefined;
  return sse(request, (send) => chat.subscribe((event) => send(event, event.seq), after));
});

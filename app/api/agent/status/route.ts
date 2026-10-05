import { agentRuntime } from "@/lib/agent/runtime";
import { json, route } from "@/lib/server/http";

/** Whether Claude Code is available and signed in, plus the models this account can use. */
export const GET = route(async (request) => {
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const runtime = agentRuntime();
  const status = await runtime.agentStatus(refresh);
  return json({ status, defaults: runtime.defaultSettings });
});

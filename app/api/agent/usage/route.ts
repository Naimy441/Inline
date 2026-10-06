import { agentRuntime } from "@/lib/agent/runtime";
import { json, route } from "@/lib/server/http";

/** The account's Claude plan usage (5-hour and weekly windows), for the usage meter. */
export const GET = route(async (request) => {
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const runtime = agentRuntime();
  const status = await runtime.agentStatus();
  if (status.state !== "ready") return json({ usage: null });
  try {
    const { sessionCostUsd: _cost, ...usage } = await runtime.planUsage({ maxAgeMs: refresh ? 15_000 : 60_000 });
    return json({ usage });
  } catch {
    // Older Claude Code builds can't report usage.
    return json({ usage: null });
  }
});

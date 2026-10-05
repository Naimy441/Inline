"use client";

import { useAgentStatus } from "@/lib/client/agentStatus";

/** Small "Claude Code connected" indicator. */
export function AgentStatusBadge() {
  const { status } = useAgentStatus();
  if (!status) return <span className="status-badge is-pending">Checking Claude Code…</span>;
  if (status.state === "ready") {
    const who = status.account.email ?? status.account.organization;
    return (
      <span className="status-badge is-ready" title={who ? `Signed in as ${who}` : "Claude Code is ready"}>
        <span className="status-dot" /> Claude Code
      </span>
    );
  }
  return (
    <span className="status-badge is-off" title={status.message}>
      <span className="status-dot" /> {status.state === "signed_out" ? "Claude Code: sign in needed" : "Claude Code unavailable"}
    </span>
  );
}

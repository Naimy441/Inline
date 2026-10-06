"use client";

import { useEffect, useState } from "react";
import type { AssistantMessage, RunStatus, ToolPart } from "@/lib/agent/types";
import { describeTool } from "@/components/agent/ToolCall";

/**
 * Signs of life while Claude works. Reasoning streams into its own block
 * (Reasoning in MessageView), text gets a writing dot and a running tool shows
 * on its own row; this line fills the waiting moments in between: before the
 * first output, between steps, while retrying or summarizing. A turning spark,
 * a word for the moment and the time so far.
 */

/** Words for the quiet stretches while Claude thinks, changed every few seconds. */
const THINKING = ["Thinking", "Considering", "Weighing words", "Mulling it over", "Reading between the lines", "Choosing words", "Thinking it through", "Sketching ideas"];

function runningTool(message: AssistantMessage | undefined): ToolPart | undefined {
  if (!message) return undefined;
  for (let i = message.parts.length - 1; i >= 0; i -= 1) {
    const part = message.parts[i]!;
    if (part.type === "tool" && (part.status === "running" || part.status === "pending")) return part;
  }
  return undefined;
}

function label(status: RunStatus | undefined, message: AssistantMessage | undefined, tick: number, elapsed: number) {
  if (!status || status.kind === "starting") return elapsed >= 2 ? "Starting Claude Code" : "Getting started";
  if (status.kind === "retrying") return `${status.error} Retrying (${status.attempt}/${status.maxRetries})`;
  if (status.kind === "compacting") return "Summarizing earlier messages to free up context";
  if (status.kind === "responding") return "Writing";
  if (status.kind === "tool") {
    const tool = runningTool(message);
    if (tool) {
      const live = describeTool(tool).live;
      return tool.name === "TodoWrite" ? "Planning" : live;
    }
  }
  return THINKING[Math.floor(tick / 4) % THINKING.length]!;
}

function formatElapsed(seconds: number) {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Whether nothing else on screen is moving: no reasoning or text streaming and
 * no tool row running. That is when the waiting line shows.
 */
export function isWaiting(status: RunStatus | undefined, message: AssistantMessage | undefined) {
  if (!status || status.kind === "starting" || status.kind === "retrying" || status.kind === "compacting") return true;
  const last = message?.parts[message.parts.length - 1];
  if (!last) return true;
  if (status.kind === "responding") return last.type !== "text";
  if (status.kind === "tool") {
    const tool = runningTool(message);
    // The plan has no row of its own (it shows above the composer).
    return !tool || tool.name === "TodoWrite";
  }
  return !(last.type === "thinking" && !last.done);
}

export function Spark({ size = 16, still }: { size?: number; still?: boolean }) {
  // Eight rounded rays, like the mark Claude shows while it works.
  return (
    <svg className={still ? "spark is-still" : "spark"} width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      {Array.from({ length: 8 }, (_, index) => (
        // The rotation sits on a group: the ray's own CSS animation would replace a transform on the ray itself.
        <g key={index} transform={`rotate(${index * 45} 12 12)`}>
          <rect className="spark-ray" x="10.4" y="1" width="3.2" height="9.5" rx="1.6" style={{ animationDelay: `${index * -0.15}s` }} />
        </g>
      ))}
    </svg>
  );
}

export function ActivityLine({ status, message, since }: { status: RunStatus | undefined; message: AssistantMessage | undefined; since?: number }) {
  // Timed from the message being sent, so the count carries on when the line comes back between steps.
  const [started] = useState(() => Math.min(since ?? Date.now(), Date.now()));
  const [now, setNow] = useState(started);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.floor((now - started) / 1000);
  const text = label(status, message, elapsed, elapsed);
  return (
    // Between steps it fades in after a beat, so a quick hand-off doesn't flash it.
    <div className={message?.parts.length ? "activity is-between" : "activity"}>
      <span className="sr-only" role="status">
        Claude is working
      </span>
      <Spark />
      <span key={text} className="activity-label" aria-hidden>
        <span className="shimmer">{text}</span>
        <span className="activity-dots" aria-hidden>
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </span>
      {elapsed >= 3 && (
        <span className="activity-time" aria-hidden>
          {formatElapsed(elapsed)}
        </span>
      )}
    </div>
  );
}

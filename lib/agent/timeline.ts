import type { AgentStep, AgentTimelineItem } from "@/lib/agent/types";

export type { AgentTimelineItem };

export function pushThinking(items: AgentTimelineItem[], fullText: string, now = Date.now()): AgentTimelineItem[] {
  if (!fullText) return items;
  const last = items.at(-1);
  const priorItems = last?.kind === "thinking" ? items.slice(0, -1) : items;
  const prior = priorItems
    .filter((item): item is Extract<AgentTimelineItem, { kind: "thinking" }> => item.kind === "thinking")
    .map((item) => item.text)
    .join("");
  const chunk = fullText.startsWith(prior) ? fullText.slice(prior.length) : fullText;
  if (!chunk) return items;
  if (last?.kind === "thinking") {
    return [...items.slice(0, -1), { ...last, text: chunk }];
  }
  return [...items, { id: `thinking-${items.length}`, kind: "thinking", text: chunk, startedAt: now }];
}

export function upsertStep(items: AgentTimelineItem[], step: AgentStep, now = Date.now()): AgentTimelineItem[] {
  const index = items.findIndex((item) => item.kind === "step" && item.step.id === step.id);
  if (index >= 0) {
    const next = [...items];
    next[index] = { id: step.id, kind: "step", step };
    return next;
  }
  return [...sealOpenThinking(items, now), { id: step.id, kind: "step", step }];
}

export function sealOpenThinking(items: AgentTimelineItem[], now = Date.now()): AgentTimelineItem[] {
  const last = items.at(-1);
  if (!last || last.kind !== "thinking" || last.durationSec != null) return items;
  const started = last.startedAt ?? now;
  return [...items.slice(0, -1), { ...last, durationSec: Math.max(0, Math.round((now - started) / 1000)) }];
}

export function formatThoughtLabel(input: { streaming?: boolean; durationSec?: number }) {
  if (input.streaming) return "Thinking";
  const seconds = input.durationSec;
  if (seconds == null || seconds < 2) return "Thought briefly";
  return `Thought ${seconds}s`;
}

export function timelineFromTurn(thinking?: string, steps?: AgentStep[]): AgentTimelineItem[] {
  const items: AgentTimelineItem[] = [];
  if (thinking?.trim()) items.push({ id: "thinking", kind: "thinking", text: thinking });
  for (const step of steps ?? []) items.push({ id: step.id, kind: "step", step });
  return items;
}

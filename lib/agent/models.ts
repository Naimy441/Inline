import type { AgentMode, AgentProvider, ThinkingLevel } from "@/lib/agent/types";

export type AgentModelOption = {
  id: string;
  label: string;
  provider: AgentProvider;
  thinking: boolean;
};

export const DEFAULT_MODEL = "gpt-5.4-nano";
export const GRAMMAR_MODEL = "gpt-4o-mini";
export const GRAMMAR_MODEL_FALLBACKS = ["gpt-4.1-mini", "gpt-4.1-nano", "gpt-4.1"] as const;

export const AGENT_MODELS: AgentModelOption[] = [
  { id: "gpt-5.4", label: "GPT-5.4", provider: "openai", thinking: true },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", provider: "openai", thinking: true },
  { id: "gpt-5.4-nano", label: "GPT-5.4 Nano", provider: "openai", thinking: true },
  { id: "gpt-5.6", label: "GPT-5.6", provider: "openai", thinking: true },
  { id: "gpt-4.1", label: "GPT-4.1", provider: "openai", thinking: false },
  { id: "gpt-4.1-mini", label: "GPT-4.1 Mini", provider: "openai", thinking: false },
  { id: "claude-opus-5", label: "Opus 5", provider: "anthropic", thinking: true },
  { id: "claude-sonnet-5", label: "Sonnet 5", provider: "anthropic", thinking: true },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", provider: "anthropic", thinking: true },
];

export const AGENT_MODES: Array<{ id: AgentMode; label: string; hint: string }> = [
  { id: "agent", label: "Agent", hint: "Edit the document" },
  { id: "plan", label: "Plan", hint: "Outline an approach" },
  { id: "ask", label: "Ask", hint: "Answer without editing" },
];

export const THINKING_LEVELS: Array<{ id: ThinkingLevel; label: string }> = [
  { id: "none", label: "None" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
];

export function isAgentMode(value: unknown): value is AgentMode {
  return value === "agent" || value === "plan" || value === "ask";
}

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

export function findAgentModel(id: string | undefined) {
  return AGENT_MODELS.find((model) => model.id === id);
}

export function resolveAgentModel(requested: string | undefined, fallback = DEFAULT_MODEL) {
  return findAgentModel(requested)?.id ?? findAgentModel(fallback)?.id ?? DEFAULT_MODEL;
}

export function modelLabel(id: string) {
  return findAgentModel(id)?.label ?? id;
}

export function thinkingLabel(level: ThinkingLevel) {
  return THINKING_LEVELS.find((item) => item.id === level)?.label ?? "Medium";
}

export function openaiEffort(level: ThinkingLevel): "none" | "low" | "medium" | "high" | "xhigh" {
  return level;
}

export function anthropicThinkingBudget(level: ThinkingLevel) {
  if (level === "none") return 0;
  if (level === "low") return 1024;
  if (level === "medium") return 4096;
  if (level === "high") return 8192;
  return 16000;
}

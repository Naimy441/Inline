import type { AssistantPart, TextPart } from "@/lib/agent/types";

/** Inline's written reply: the text it showed, without reasoning or tool output. */
export function assistantReplyText(parts: readonly AssistantPart[]): string {
  return parts
    .filter((part): part is TextPart => part.type === "text" && part.text.trim() !== "")
    .map((part) => part.text.trim())
    .join("\n\n");
}

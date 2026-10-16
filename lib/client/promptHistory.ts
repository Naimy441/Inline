/** Sent prompts, oldest first: this chat's messages, then anything still queued behind a running reply. */
export function promptTexts(messages: readonly { role: string; text?: string }[], queued: readonly { text: string }[] = []): string[] {
  return [...messages.flatMap((message) => (message.role === "user" && message.text ? [message.text] : [])), ...queued.flatMap((item) => (item.text ? [item.text] : []))];
}

/** `null` is the empty draft after the newest prompt. A number is that prompt's index. */
export type PromptCursor = number | null;

export type PromptRecall = { handled: false } | { handled: true; text: string; cursor: PromptCursor };

/**
 * ArrowUp and ArrowDown recall prompt history only while the draft is empty.
 * A non-empty draft is left untouched, so the keys still move the caret.
 *
 * From the empty draft, either arrow loads the previous prompt. After that
 * prompt is cleared, ArrowUp steps to older ones and ArrowDown steps back
 * toward the empty draft.
 */
export function recallPrompt(history: readonly string[], cursor: PromptCursor, key: "ArrowUp" | "ArrowDown", draft: string): PromptRecall {
  if (draft !== "") return { handled: false };
  if (history.length === 0) return { handled: false };

  const pos = cursor === null || cursor > history.length ? history.length : Math.max(0, cursor);

  if (key === "ArrowUp") {
    const next = pos === 0 ? 0 : pos - 1;
    return { handled: true, text: history[next]!, cursor: next };
  }

  // Empty, and not already walking: ArrowDown loads the previous prompt too.
  if (pos >= history.length) return { handled: true, text: history[history.length - 1]!, cursor: history.length - 1 };
  const next = pos + 1;
  if (next >= history.length) return { handled: true, text: "", cursor: null };
  return { handled: true, text: history[next]!, cursor: next };
}

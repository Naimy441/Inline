import assert from "node:assert/strict";
import { test } from "node:test";

import { assistantReplyText } from "@/lib/agent/messageText";
import type { AssistantPart } from "@/lib/agent/types";

test("the copied response is Inline's text, not its reasoning or tool output", () => {
  const parts: AssistantPart[] = [
    { type: "thinking", id: "t", text: "I'll read the document, then make the edit." },
    { type: "tool", id: "tool", name: "mcp__inline__edit_document", input: {}, status: "done", result: "edited Tuesday" },
    { type: "text", id: "a", text: "Replaced Tuesday with Thursday." },
    { type: "text", id: "b", text: "   " },
    { type: "text", id: "c", text: "Done." },
  ];
  assert.equal(assistantReplyText(parts), "Replaced Tuesday with Thursday.\n\nDone.");
});

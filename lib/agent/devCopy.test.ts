import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatChatHistory, formatPromptTurn, promptTurns, turnCopyTargets, turnForMessage } from "@/lib/agent/devCopy";
import type { AssistantMessage, ChatMessage, UserMessage } from "@/lib/agent/types";

function user(id: string, text: string, extra: Partial<UserMessage> = {}): UserMessage {
  return { id, role: "user", text, createdAt: 1, ...extra };
}

function reply(id: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return { id, role: "assistant", createdAt: 2, parts: [], status: "done", ...extra };
}

const secret = "sk-should-not-be-invented";

describe("developer copy", () => {
  it("copies one turn as prompt, thoughts, tool calls and the response", () => {
    const messages: ChatMessage[] = [
      user("u1", "Replace Tuesday with Thursday.", {
        selection: { documentId: "doc", text: "The meeting is on Tuesday.", from: 1, to: 2 },
        attachments: [{ id: "a", name: "notes.txt", mime: "text/plain", size: 12, kind: "text" }],
        mentions: [{ id: "other", title: "Agenda" }],
      }),
      reply("a1", {
        model: "claude-secret-model",
        sessionPoint: secret,
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 9, durationMs: 10, numTurns: 1 },
        parts: [
          { type: "thinking", id: "t1", text: "I'll read the document, then make the edit." },
          { type: "tool", id: "tool-1", name: "mcp__inline__read_document", input: { document_id: "doc" }, status: "done", result: "1\tThe meeting is on Tuesday." },
          { type: "tool", id: "tool-2", name: "mcp__inline__edit_document", input: { old_string: "Tuesday", new_string: "Thursday" }, status: "done", result: "Edited." },
          { type: "text", id: "x1", text: "Replaced Tuesday with Thursday." },
        ],
        changes: [{ documentId: "doc", title: "Notes", tool: "edit_document", added: 1, removed: 1, checkpoint: secret }],
      }),
    ];
    const text = formatPromptTurn(promptTurns(messages)[0]!);
    assert.equal(
      text,
      [
        "Prompt:",
        "Replace Tuesday with Thursday.",
        "",
        "Selected text:",
        "The meeting is on Tuesday.",
        "",
        "Attachments: notes.txt",
        "",
        "Mentioned documents: Agenda",
        "",
        "Thoughts:",
        "I'll read the document, then make the edit.",
        "",
        "Tool calls:",
        "read_document (done)",
        "Input:",
        JSON.stringify({ document_id: "doc" }, null, 2),
        "Result:",
        "1\tThe meeting is on Tuesday.",
        "",
        "edit_document (done)",
        "Input:",
        JSON.stringify({ old_string: "Tuesday", new_string: "Thursday" }, null, 2),
        "Result:",
        "Edited.",
        "",
        "Response:",
        "Replaced Tuesday with Thursday.",
      ].join("\n"),
    );
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes("claude-secret-model"), false);
    assert.equal(text.includes("costUsd"), false);
  });

  it("copies the whole chat as the same form, one block per turn", () => {
    const messages: ChatMessage[] = [
      user("u1", "First question"),
      reply("a1", { parts: [{ type: "text", id: "t", text: "First answer" }] }),
      user("u2", "Second question"),
      reply("a2", {
        status: "error",
        error: "Not logged in.",
        parts: [{ type: "thinking", id: "th", text: "Trying again." }],
      }),
    ];
    const history = formatChatHistory(messages);
    assert.match(history, /^Turn 1\n\nPrompt:\nFirst question/);
    assert.match(history, /Response:\nFirst answer/);
    assert.match(history, /\n\n---\n\nTurn 2\n\nPrompt:\nSecond question/);
    assert.match(history, /Thoughts:\nTrying again\./);
    assert.match(history, /Tool calls:\n\(none\)/);
    assert.match(history, /Response:\nError: Not logged in\./);
    assert.deepEqual([...turnCopyTargets(messages)], ["a1", "a2"]);
    assert.equal(turnForMessage(messages, "u2")?.prompt?.text, "Second question");
  });

  it("offers copy on a prompt that has no reply yet, and leaves empty sections marked", () => {
    const messages: ChatMessage[] = [user("u1", "Hello")];
    assert.deepEqual([...turnCopyTargets(messages)], ["u1"]);
    assert.match(formatPromptTurn(promptTurns(messages)[0]!), /Prompt:\nHello\n\nThoughts:\n\(none\)\n\nTool calls:\n\(none\)\n\nResponse:\n\(none\)/);
    assert.equal(formatChatHistory([]), "(none)");
  });
});

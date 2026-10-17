import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatChatHistory, formatChatLogs, formatPromptTurn, formatTurnLog, promptTurns, turnCopyTargets, turnForMessage } from "@/lib/agent/devCopy";
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

  it("copies chat logs with the document around each turn, and leaves chat history without that", () => {
    const messages: ChatMessage[] = [
      user("u1", "Replace Tuesday with Thursday."),
      reply("a1", {
        model: "claude-secret-model",
        sessionPoint: secret,
        parts: [
          { type: "tool", id: "tool-1", name: "mcp__inline__edit_document", input: { old_string: "Tuesday", new_string: "Thursday" }, status: "done", result: "Edited." },
          { type: "text", id: "x1", text: "Replaced Tuesday with Thursday." },
        ],
        changes: [{ documentId: "doc-1", title: "Notes", tool: "edit_document", added: 1, removed: 1, checkpoint: secret }],
        documentLog: [
          {
            documentId: "doc-1",
            title: "Notes",
            before: "The meeting is on Tuesday.",
            after: "The meeting is on Thursday.",
            pending: [{ id: "h1", deleted: "Tuesday", inserted: "Thursday" }],
          },
        ],
      }),
      user("u2", "Say hello back"),
      reply("a2", {
        parts: [{ type: "text", id: "t2", text: "You said: Say hello back" }],
        documentLog: [{ documentId: "doc-1", title: "Notes" }],
      }),
    ];
    const history = formatChatHistory(messages);
    assert.equal(history.includes("Before:"), false);
    assert.equal(history.includes("Pending review:"), false);
    assert.equal(history.includes("Document:"), false);
    assert.equal(history.includes(secret), false);

    const logs = formatChatLogs(messages);
    assert.match(logs, /Turn 1\n\nPrompt:\nReplace Tuesday with Thursday\./);
    assert.match(logs, /Before:\nThe meeting is on Tuesday\./);
    assert.match(logs, /After:\nThe meeting is on Thursday\./);
    assert.match(logs, /Pending review:\n- h1: "Tuesday" → "Thursday"/);
    assert.match(logs, /id: doc-1\ntitle: Notes/);
    assert.match(logs, /Turn 2\n\nPrompt:\nSay hello back/);
    assert.equal(logs.includes(secret), false);
    assert.equal(logs.includes("claude-secret-model"), false);

    const first = formatTurnLog(turnForMessage(messages, "a1")!);
    assert.match(first, /Before:\nThe meeting is on Tuesday\./);
    assert.equal(first.includes("Say hello back"), false);
    assert.equal(first.includes("Turn "), false);

    const second = formatTurnLog(turnForMessage(messages, "u2")!);
    assert.match(second, /Prompt:\nSay hello back/);
    assert.match(second, /id: doc-1/);
    assert.match(second, /Changes:\n\(none\)/);
    assert.match(second, /Pending review:\n\(none\)/);
    assert.equal(second.includes("Replace Tuesday"), false);
    assert.equal(second.includes("Before:"), false);
  });

  it("offers copy on a prompt that has no reply yet, and leaves empty sections marked", () => {
    const messages: ChatMessage[] = [user("u1", "Hello")];
    assert.deepEqual([...turnCopyTargets(messages)], ["u1"]);
    assert.match(formatPromptTurn(promptTurns(messages)[0]!), /Prompt:\nHello\n\nThoughts:\n\(none\)\n\nTool calls:\n\(none\)\n\nResponse:\n\(none\)/);
    assert.match(formatTurnLog(promptTurns(messages)[0]!), /Document:\n\(none\)/);
    assert.equal(formatChatHistory([]), "(none)");
    assert.equal(formatChatLogs([]), "(none)");
  });
});

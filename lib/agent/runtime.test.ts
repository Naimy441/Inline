import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

// The store resolves its directory on each call, so this applies before any write.
process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-runtime-"));

import { mcpToolName } from "@/lib/agent/mcp";
import { agentRuntime, BUILTIN_TOOLS, setQueryImplementation, type ChatRuntime } from "@/lib/agent/runtime";
import { fakeClaude, type FakeModel } from "@/lib/agent/testing/fakeClaude";
import type { AssistantMessage, ChatEvent, ChatSettings, ToolPart, UserMessage } from "@/lib/agent/types";
import { docToMarkdown } from "@/lib/doc/markdown";
import { documentHub } from "@/lib/server/hub";
import { listVersions, readChatFile, writeChatFile } from "@/lib/server/store";

/**
 * The agent runtime driven by a scripted Claude Code (see testing/fakeClaude.ts).
 * Tool calls go through the real in-process MCP server into real documents, so
 * these cover the whole path from a chat message to a reviewable edit.
 */

const NOTES = "# Field notes {.title}\n\nThe quick brown fox jumps over the lazy dog.\n\n## Findings\n\n- Foxes are quick\n- Dogs are lazy";

afterEach(() => setQueryImplementation(null));

function useModel(model: FakeModel) {
  const fake = fakeClaude(model);
  setQueryImplementation(fake.query);
  return fake;
}

async function newChat(options: { markdown?: string; settings?: Partial<ChatSettings> } = {}) {
  const doc = await documentHub().create({ title: "Field notes", markdown: options.markdown ?? NOTES });
  const chat = await agentRuntime().create({ documentId: doc.id, settings: options.settings });
  return { doc, chat };
}

function record(chat: ChatRuntime) {
  const events: ChatEvent[] = [];
  chat.subscribe((event) => events.push(event));
  return events;
}

/** Resolves after the chat has finished `turns` more turns. */
function idle(chat: ChatRuntime, turns = 1) {
  return new Promise<void>((resolve) => {
    let left = turns;
    const off = chat.subscribe((event) => {
      if (event.type === "running" && !event.running && --left === 0) {
        off();
        resolve();
      }
    });
  });
}

async function turn(chat: ChatRuntime, text: string, extra: Partial<Parameters<ChatRuntime["send"]>[0]> = {}) {
  const done = idle(chat);
  await chat.send({ text, ...extra });
  await done;
  return lastAssistant(chat);
}

function lastAssistant(chat: ChatRuntime) {
  return [...chat.state.messages].reverse().find((message) => message.role === "assistant") as AssistantMessage;
}

const tools = (message: AssistantMessage) => message.parts.filter((part): part is ToolPart => part.type === "tool");

describe("a turn", () => {
  it("streams the reply, records usage and persists the chat", async () => {
    const fake = useModel((_turn, claude) => {
      claude.think("The user wants a summary.");
      claude.say("Here is a short summary of your notes.");
    });
    const { chat } = await newChat();
    const events = record(chat);
    const reply = await turn(chat, "Summarize my notes please");

    assert.equal(reply.status, "done");
    assert.deepEqual(
      reply.parts.map((part) => part.type),
      ["thinking", "text"],
    );
    assert.equal(reply.parts[1]!.type === "text" && reply.parts[1]!.text, "Here is a short summary of your notes.");
    assert.equal(reply.model, "claude-test");
    assert.deepEqual(reply.usage, { inputTokens: 120, outputTokens: 40, cacheReadTokens: 10, cacheCreationTokens: 5, costUsd: 0.0123, durationMs: 1234, numTurns: 2 });
    assert.equal(chat.state.title, "Summarize my notes please");
    assert.equal(chat.state.running, false);

    const deltas = events.filter((event) => event.type === "text_delta").map((event) => (event as { text: string }).text);
    assert.ok(deltas.length > 1, "text arrives in pieces");
    assert.equal(deltas.join(""), "Here is a short summary of your notes.");
    const statuses = events.filter((event) => event.type === "status").map((event) => (event as { status: { kind: string } | null }).status?.kind ?? null);
    assert.equal(statuses[0], "starting");
    assert.ok(statuses.includes("responding"));
    assert.equal(statuses.at(-1), null);

    await chat.persistNow();
    const saved = await readChatFile<{ messages: unknown[]; sessionStarted: boolean }>(chat.state.id);
    assert.equal(saved?.messages.length, 2);
    assert.equal(saved?.sessionStarted, true);

    const options = fake.sessions[0]!.options;
    assert.deepEqual(options.tools, BUILTIN_TOOLS);
    assert.deepEqual(options.allowedTools, [mcpToolName("*"), ...BUILTIN_TOOLS]);
    assert.equal(options.sessionId, chat.state.id, "the Claude Code session takes the chat's id");
    assert.equal(options.resume, undefined);
    assert.deepEqual(options.settingSources, [], "the user's own Claude Code settings and hooks are not loaded");
  });

  it("tells Claude which document is open, the mode and what the user selected", async () => {
    const fake = useModel(() => undefined);
    const { doc, chat } = await newChat();
    await turn(chat, "Tighten this", { selection: { documentId: doc.id, text: "lazy dog", from: 1, to: 2 } });
    const { context, text } = fake.turns[0]!;
    assert.equal(text, "Tighten this");
    assert.match(context, /^<inline-context>/);
    assert.match(context, /Mode: Agent/);
    assert.match(context, new RegExp(`Open document: "Field notes" \\(id ${doc.id}\\)`));
    assert.match(context, /The user selected this text in the document:\n"""\nlazy dog\n"""/);
  });

  it("mentions pending changes, the user's suggestions and the editor mode", async () => {
    const fake = useModel(async (_turn, claude) => {
      if (fake.turns.length === 1) await claude.call("edit_document", { old_string: "lazy dog", new_string: "sleepy dog" });
    });
    const { doc, chat } = await newChat();
    await turn(chat, "Edit something");
    doc.editorMode = "suggesting";
    await turn(chat, "What's pending?");
    const context = fake.turns[1]!.context;
    assert.match(context, /1 earlier change by Claude is still awaiting the user's review/);
    assert.match(context, /editor is in suggesting mode/);
  });

  it("tells Claude where the cursor is when the inline prompt has no selection", async () => {
    const fake = useModel(() => undefined);
    const { doc, chat } = await newChat();
    const { findText } = await import("@/lib/doc/editing");
    const at = findText(doc.doc, "jumps", { caseSensitive: true })[0]!.from;
    await turn(chat, "Add an adjective", { selection: { documentId: doc.id, text: "", from: at, to: at } });
    const { context } = fake.turns[0]!;
    assert.match(context, /The user's cursor is on line \d+ of read_document, after "The quick brown fox " in this paragraph:/);
    assert.match(context, /"""\nThe quick brown fox jumps over the lazy dog\.\n"""/);
    assert.doesNotMatch(context, /The user selected/);
  });

  it("lists @-mentioned documents and keeps them on the message", async () => {
    const fake = useModel(() => undefined);
    const { chat } = await newChat();
    await turn(chat, "Compare with @Budget", { mentions: [{ id: "doc-123", title: "Budget" }] });
    assert.match(fake.turns[0]!.context, /The user mentioned this document: "Budget" \(id doc-123\)/);
    const user = chat.state.messages.find((message) => message.role === "user");
    assert.deepEqual(user && "mentions" in user ? user.mentions : null, [{ id: "doc-123", title: "Budget" }]);
  });

  it("says when no document is open", async () => {
    const fake = useModel(() => undefined);
    const chat = await agentRuntime().create();
    await turn(chat, "Hello");
    assert.match(fake.turns[0]!.context, /No document is open/);
  });

  it("rejects an empty message", async () => {
    useModel(() => undefined);
    const { chat } = await newChat();
    await assert.rejects(chat.send({ text: "   " }), /empty/);
  });
});

describe("editing through MCP", () => {
  it("applies Claude's edits as reviewable changes and reports them on the reply", async () => {
    useModel(async (_turn, claude) => {
      const read = await claude.call("read_document");
      assert.match(read.text, /lazy dog/);
      await claude.call("edit_document", { old_string: "lazy dog", new_string: "sleepy dog" });
      await claude.call("edit_document", { old_string: "Dogs are lazy", new_string: "Dogs are sleepy" });
      claude.say("Done: the dog is sleepy now.");
    });
    const { doc, chat } = await newChat();
    const events = record(chat);
    const reply = await turn(chat, "Make the dog sleepy");

    assert.match(docToMarkdown(doc.doc), /sleepy dog/);
    assert.match(docToMarkdown(doc.doc), /Dogs are sleepy/);
    assert.equal(doc.hunks.length, 2);
    assert.ok(doc.hunks.every((hunk) => hunk.author === chat.state.id), "changes are attributed to this chat");

    const parts = tools(reply);
    assert.deepEqual(
      parts.map((part) => [part.name, part.status]),
      [
        ["mcp__inline__read_document", "done"],
        ["mcp__inline__edit_document", "done"],
        ["mcp__inline__edit_document", "done"],
      ],
    );
    assert.deepEqual(parts[1]!.input, { old_string: "lazy dog", new_string: "sleepy dog" });
    assert.match(parts[1]!.result ?? "", /sleepy dog/);
    assert.ok(events.some((event) => event.type === "tool_input_delta"), "tool input streams while Claude writes it");

    assert.equal(reply.changes?.length, 1);
    assert.equal(reply.changes![0]!.documentId, doc.id);
    assert.ok(reply.changes![0]!.added >= 2 && reply.changes![0]!.removed >= 2);
    assert.equal(events.filter((event) => event.type === "change").length, 2);
  });

  it("checkpoints the document once before Claude's first edit in each turn", async () => {
    useModel(async (turnInput, claude) => {
      await claude.call("edit_document", { old_string: "quick", new_string: turnInput.text });
      await claude.call("edit_document", { old_string: "Findings", new_string: `Findings ${turnInput.text}` });
    });
    const { doc, chat } = await newChat();
    await turn(chat, "swift");
    await turn(chat, "fast");
    const checkpoints = (await listVersions(doc.id)).filter((version) => version.label === "Before Claude's edits");
    assert.equal(checkpoints.length, 2);
  });

  it("refuses edits in Ask mode and marks the tool call failed", async () => {
    useModel(async (_turn, claude) => {
      const result = await claude.call("write_document", { content: "Everything replaced." });
      assert.equal(result.isError, true);
      claude.say("I can't edit in Ask mode.");
    });
    const { doc, chat } = await newChat({ settings: { mode: "ask" } });
    const before = docToMarkdown(doc.doc);
    const reply = await turn(chat, "Rewrite it");
    assert.equal(docToMarkdown(doc.doc), before);
    assert.equal(tools(reply)[0]!.status, "error");
    assert.match(tools(reply)[0]!.result ?? "", /Ask mode/);
    assert.equal(reply.status, "done");
  });

  it("follows the document the user switches to", async () => {
    const fake = useModel(async (_turn, claude) => {
      await claude.call("edit_document", { old_string: "Second", new_string: "2nd" });
    });
    const { chat } = await newChat();
    const other = await documentHub().create({ title: "Other", markdown: "Second document." });
    await turn(chat, "Fix it", { documentId: other.id });
    assert.equal(chat.state.documentId, other.id);
    assert.match(fake.turns[0]!.context, /Open document: "Other"/);
    assert.equal(docToMarkdown(other.doc).trim(), "2nd document.");
  });

  it("keeps the plan from TodoWrite and ignores subagent chatter", async () => {
    useModel((_turn, claude) => {
      claude.builtin("TodoWrite", {
        todos: [
          { content: "Read the draft", activeForm: "Reading the draft", status: "completed" },
          { content: "Fix the intro", activeForm: "Fixing the intro", status: "in_progress" },
        ],
      });
      claude.raw({ type: "assistant", parent_tool_use_id: "toolu_sub", message: { id: "sub", role: "assistant", content: [{ type: "text", text: "subagent noise" }] } });
      claude.say("Working on it.");
    });
    const { chat } = await newChat();
    const reply = await turn(chat, "Plan it");
    assert.deepEqual(
      chat.state.todos.map((todo) => [todo.content, todo.status]),
      [
        ["Read the draft", "completed"],
        ["Fix the intro", "in_progress"],
      ],
    );
    assert.ok(!reply.parts.some((part) => part.type === "text" && part.text.includes("subagent noise")));
  });
});

describe("queueing, interrupting and errors", () => {
  it("queues messages sent mid-turn and runs them in order", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fake = useModel(async (input, claude) => {
      if (input.text === "first") await gate;
      claude.say(`Answer to ${input.text}`);
    });
    const { chat } = await newChat();
    const done = idle(chat, 3);
    await chat.send({ text: "first" });
    assert.deepEqual(await chat.send({ text: "second" }).then((result) => result.queued), true);
    const dropped = await chat.send({ text: "dropped" });
    await chat.send({ text: "third" });
    chat.removeQueued(dropped.id);
    assert.deepEqual(
      chat.state.queue.map((item) => item.text),
      ["second", "third"],
    );
    release();
    await done;
    assert.deepEqual(
      fake.turns.map((item) => item.text),
      ["first", "second", "third"],
    );
    assert.equal(fake.sessions.length, 1, "follow-ups reuse the live Claude Code session");
    const answers = chat.state.messages.filter((message) => message.role === "assistant").map((message) => (message as AssistantMessage).parts.find((part) => part.type === "text"));
    assert.deepEqual(
      answers.map((part) => part?.type === "text" && part.text),
      ["Answer to first", "Answer to second", "Answer to third"],
    );
  });

  it("stops a turn when interrupted and drops the queue", async () => {
    useModel(async (_turn, claude) => {
      claude.say("Starting a long job.");
      claude.hangingTool("mcp__inline__read_document");
      await claude.untilInterrupted();
    });
    const { chat } = await newChat();
    const done = idle(chat);
    await chat.send({ text: "Long job" });
    await chat.send({ text: "queued follow-up" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await chat.interrupt();
    await done;
    const reply = lastAssistant(chat);
    assert.equal(reply.status, "stopped");
    assert.equal(reply.error, undefined);
    assert.equal(tools(reply)[0]!.status, "error", "an unfinished tool call isn't left spinning");
    assert.deepEqual(chat.state.queue, []);
    assert.equal(chat.state.messages.filter((message) => message.role === "user").length, 1);
  });

  it("explains a turn limit, a missing login and an unexpected exit", async () => {
    const scripts: FakeModel[] = [
      (_turn, claude) => claude.finish({ subtype: "error_max_turns" }),
      (_turn, claude) => claude.crash("Error: Not logged in. Please run /login"),
      (_turn, claude) => claude.exit(),
    ];
    const expected = [/limit for one message/, /sign/i, /exited unexpectedly/];
    for (const [index, script] of scripts.entries()) {
      useModel(script);
      const { chat } = await newChat();
      const reply = await turn(chat, "Try");
      assert.equal(reply.status, "error", `case ${index}`);
      assert.match(reply.error ?? "", expected[index]!);
    }
  });

  it("retries the last message after an error, replacing the failed reply", async () => {
    let attempts = 0;
    const fake = useModel((_turn, claude) => {
      attempts += 1;
      if (attempts === 1) claude.crash("overloaded");
      else claude.say("Second time lucky.");
    });
    const { chat } = await newChat();
    await turn(chat, "Please work");
    assert.equal(lastAssistant(chat).status, "error");
    const done = idle(chat);
    await chat.retry();
    await done;
    assert.equal(chat.state.messages.length, 2, "the failed exchange is replaced, not duplicated");
    assert.equal((chat.state.messages[0] as UserMessage).text, "Please work");
    assert.equal(lastAssistant(chat).status, "done");
    assert.equal(fake.sessions.length, 2, "a crashed session is replaced");
    assert.equal(fake.sessions[1]!.options.resume, chat.state.id, "and the new one resumes the conversation");
  });

  it("reports rate limits, retries and context usage", async () => {
    useModel((_turn, claude) => {
      claude.raw({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 3, retry_delay_ms: 500, error: "overloaded" });
      claude.raw({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1_800_000_000, rateLimitType: "five_hour", utilization: 0.9 } });
      claude.say("ok");
    });
    const { chat } = await newChat();
    const events = record(chat);
    await turn(chat, "Hi");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(events.some((event) => event.type === "status" && event.status?.kind === "retrying" && event.status.attempt === 1));
    const limit = events.find((event) => event.type === "rate_limit");
    assert.deepEqual(limit && "rateLimit" in limit && limit.rateLimit, { status: "allowed_warning", resetsAt: 1_800_000_000, type: "five_hour", utilization: 0.9 });
    assert.deepEqual(chat.state.context, { tokens: 24_000, maxTokens: 200_000, percentage: 12 });
  });
});

describe("sessions and settings", () => {
  it("resumes the Claude Code session after it was closed", async () => {
    const fake = useModel((_turn, claude) => claude.say("hi"));
    const { chat } = await newChat();
    await turn(chat, "One");
    chat.close();
    await turn(chat, "Two");
    assert.equal(fake.sessions.length, 2);
    assert.equal(fake.sessions[0]!.options.sessionId, chat.state.id);
    assert.equal(fake.sessions[1]!.options.resume, chat.state.id);
  });

  it("switches model and effort on the live session", async () => {
    const fake = useModel((_turn, claude) => claude.say("hi"));
    const { chat } = await newChat({ settings: { model: "sonnet", effort: "medium" } });
    await turn(chat, "One");
    assert.equal(fake.sessions[0]!.options.model, "sonnet");
    assert.equal(fake.sessions[0]!.options.effort, "medium");
    await chat.update({ settings: { model: "opus", effort: "high" } });
    assert.deepEqual(fake.modelChanges, ["opus"]);
    assert.deepEqual(fake.effortChanges, ["high"]);
    assert.equal(chat.state.settings.model, "opus");
  });

  it("marks a reply that was streaming when Inline restarted as stopped", async () => {
    useModel(() => undefined);
    const id = "restarted-chat";
    await writeChatFile(id, {
      format: 1,
      id,
      title: "Old chat",
      documentId: null,
      createdAt: 1,
      updatedAt: 1,
      settings: { model: null, effort: "medium", mode: "agent" },
      messages: [
        { id: "u", role: "user", text: "Hi", createdAt: 1 },
        { id: "a", role: "assistant", createdAt: 1, status: "streaming", parts: [{ type: "tool", id: "t", name: "x", input: {}, status: "running" }] },
      ],
      todos: [],
      sessionStarted: true,
    });
    const chat = await agentRuntime().require(id);
    const reply = lastAssistant(chat);
    assert.equal(reply.status, "stopped");
    assert.match(reply.error ?? "", /restarted/);
    assert.equal(tools(reply)[0]!.status, "error");
  });

  it("lists chats per document and deletes them", async () => {
    useModel((_turn, claude) => claude.say("hi"));
    const { doc, chat } = await newChat();
    await agentRuntime().create({ documentId: doc.id });
    await turn(chat, "Listed");
    const listed = await agentRuntime().list({ documentId: doc.id });
    assert.deepEqual(
      listed.map((item) => item.id),
      [chat.state.id],
      "empty chats are left out",
    );
    await agentRuntime().remove(chat.state.id);
    assert.equal(await readChatFile(chat.state.id), null);
    assert.deepEqual(await agentRuntime().list({ documentId: doc.id }), []);
  });

  it("reports a signed-in Claude Code account and its models", async () => {
    useModel(() => undefined);
    const status = await agentRuntime().agentStatus(true);
    assert.equal(status.state, "ready");
    assert.equal(status.state === "ready" && status.account.email, "writer@example.com");
    assert.equal(status.state === "ready" && status.defaultModel, "default");
  });
});

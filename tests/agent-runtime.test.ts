import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, mock, test } from "node:test";

import type { AssistantMessage, SequencedChatEvent, ToolPart, UserMessage } from "@/lib/agent/types";
import type { ChatRuntime } from "@/lib/agent/runtime";
import type { LiveDocument } from "@/lib/server/hub";

import { FakeClaude } from "./support/fake-claude";
import { useTempDataDir } from "./support/mcp";

/**
 * The in-app agent runtime driven end to end with a scripted Claude Code
 * (see support/fake-claude.ts). Everything except the model is real: the
 * runtime, the in-process MCP server, the tools, the document hub and the
 * file store.
 */

const dataDir = useTempDataDir("inline-runtime-");
const claude = new FakeClaude();

type Runtime = ReturnType<typeof import("@/lib/agent/runtime").agentRuntime>;
let runtime: Runtime;
let hub: ReturnType<typeof import("@/lib/server/hub").documentHub>;
let markdownOf: (doc: LiveDocument) => string;
let saveUpload: typeof import("@/lib/server/store").saveUpload;

before(async () => {
  const real = await import("@anthropic-ai/claude-agent-sdk");
  mock.module("@anthropic-ai/claude-agent-sdk", { namedExports: { ...real, query: claude.query } });
  const runtimeModule = await import("@/lib/agent/runtime");
  runtime = runtimeModule.agentRuntime();
  hub = (await import("@/lib/server/hub")).documentHub();
  const { docToMarkdown } = await import("@/lib/doc/markdown");
  markdownOf = (doc) => docToMarkdown(doc.doc);
  saveUpload = (await import("@/lib/server/store")).saveUpload;
});

after(() => {
  // Close live sessions so their idle timers don't keep the process alive.
  for (const chat of (runtime as unknown as { chats: Map<string, ChatRuntime> }).chats.values()) chat.close();
});

beforeEach(() => {
  claude.scripts = [];
});

const NOTE = "# Trip {.title}\n\nWe leave on Monday.\n\nPack light.";

function record(chat: ChatRuntime) {
  const events: SequencedChatEvent[] = [];
  chat.subscribe((event) => events.push(event));
  return events;
}

async function waitFor<T>(check: () => T | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function idle(chat: ChatRuntime) {
  return waitFor(() => !chat.state.running && chat.state.messages.length > 0 && (chat.state.messages.at(-1) as AssistantMessage).status !== "streaming", "the turn to finish");
}

function lastAssistant(chat: ChatRuntime) {
  return chat.state.messages.at(-1) as AssistantMessage;
}

async function newChat(markdown = NOTE, settings = {}) {
  const doc = await hub.create({ title: "Trip", markdown });
  const chat = await runtime.create({ documentId: doc.id, settings });
  return { doc, chat };
}

describe("a plain conversation turn", () => {
  test("streams text into an assistant message and finishes with usage", async () => {
    const { chat } = await newChat();
    const events = record(chat);
    claude.script(async (turn) => {
      turn.think("The user wants a summary.");
      turn.say("Your trip starts on Monday.");
    });
    const sent = await chat.send({ text: "When do we leave?" });
    assert.equal(sent.queued, false);
    await idle(chat);

    const [user, assistant] = chat.state.messages as [UserMessage, AssistantMessage];
    assert.equal(user.text, "When do we leave?");
    assert.equal(sent.id, user.id);
    assert.equal(assistant.status, "done");
    assert.deepEqual(
      assistant.parts.map((part) => part.type),
      ["thinking", "text"],
    );
    assert.equal(assistant.parts[1]!.type === "text" && assistant.parts[1]!.text, "Your trip starts on Monday.");
    assert.equal(assistant.model, "claude-test-model");
    assert.deepEqual(assistant.usage, { inputTokens: 900, outputTokens: 150, cacheReadTokens: 4000, cacheCreationTokens: 100, costUsd: 0.0123, durationMs: 1200, numTurns: 2 });

    const types = events.map((event) => event.type);
    assert.equal(types[0], "snapshot");
    for (const type of ["message", "running", "status", "part", "text_delta", "thinking_delta", "message_done"]) assert.ok(types.includes(type as never), `missing ${type}`);
    assert.deepEqual(
      events.filter((event) => event.type === "running").map((event) => (event as { running: boolean }).running),
      [true, false],
    );
    const deltas = events.filter((event) => event.type === "text_delta").map((event) => (event as { text: string }).text);
    assert.ok(deltas.length > 1, "text streams in several deltas");
    assert.equal(deltas.join(""), "Your trip starts on Monday.");
    const seqs = events.map((event) => event.seq);
    assert.deepEqual(
      seqs.slice(1),
      [...seqs.slice(1)].sort((a, b) => a - b),
      "sequence numbers increase",
    );
    await waitFor(() => chat.state.context, "context usage");
    assert.equal(chat.state.context!.percentage, 6);
  });

  test("the first message names the chat", async () => {
    const { chat } = await newChat();
    await chat.send({ text: "Help me plan the packing list for a week in the mountains" });
    await idle(chat);
    assert.equal(chat.state.title, "Help me plan the packing list for a week in the mountains");
    assert.equal(chat.summary().messageCount, 2);
    assert.equal(chat.summary().preview, "OK.");
  });

  test("empty messages are refused", async () => {
    const { chat } = await newChat();
    await assert.rejects(chat.send({ text: "   " }), /Message is empty/);
  });

  test("the query is configured as a sandboxed Claude Code session with only Inline's tools", async () => {
    const { chat } = await newChat(NOTE, { model: "claude-test-opus", effort: "high" });
    await chat.send({ text: "hi" });
    await idle(chat);
    const options = claude.lastCall.options as Record<string, unknown>;
    assert.deepEqual(options.tools, ["WebSearch", "WebFetch", "TodoWrite"]);
    assert.deepEqual(options.allowedTools, ["mcp__inline__*", "WebSearch", "WebFetch", "TodoWrite"]);
    assert.deepEqual(options.settingSources, [], "the user's own Claude Code settings and hooks don't leak in");
    assert.equal(options.model, "claude-test-opus");
    assert.equal(options.effort, "high");
    assert.equal(options.sessionId, chat.state.id);
    assert.equal(options.resume, undefined);
    assert.equal(options.persistSession, true);
    assert.ok((options.mcpServers as Record<string, unknown>).inline, "Inline's MCP server is attached");
    assert.match(String(options.systemPrompt), /Inline/);
    assert.equal(path.dirname(String(options.cwd)), dataDir, "Claude Code runs in Inline's workspace, not the repo");
  });
});

describe("context sent with each message", () => {
  test("names the open document, pending changes, editor mode and selection", async () => {
    const { doc, chat } = await newChat();
    await hub.get(doc.id);
    let seen: string[] = [];
    claude.script(async (turn) => {
      await turn.tool("mcp__inline__edit_document", { old_string: "Monday", new_string: "Tuesday" });
      turn.say("Changed.");
    });
    await chat.send({ text: "Change the day" });
    await idle(chat);
    doc.editorMode = "suggesting";
    claude.script((turn) => {
      seen = turn.texts;
      turn.say("Noted.");
    });
    await chat.send({ text: "Make this punchier", selection: { documentId: doc.id, text: "Pack light.", from: 1, to: 5 } });
    await idle(chat);
    const [context, text] = seen;
    assert.match(context!, /^<inline-context>/);
    assert.match(context!, /Mode: Agent\. Make requested changes directly in the document\./);
    assert.match(context!, new RegExp(`Open document: "Trip" \\(id ${doc.id}\\)\\.`));
    assert.match(context!, /1 earlier change is by Claude still awaiting the user's review\./);
    assert.match(context!, /editor is in suggesting mode/);
    assert.match(context!, /The user selected this text in the document:\n"""\nPack light\.\n"""/);
    assert.equal(text, "Make this punchier");
  });

  test("says when no document is open, and Ask mode", async () => {
    const chat = await runtime.create({ documentId: null, settings: { mode: "ask" } });
    let seen = "";
    claude.script((turn) => {
      seen = turn.texts[0]!;
    });
    await chat.send({ text: "What can you do?" });
    await idle(chat);
    assert.match(seen, /Mode: Ask\. You can read documents but not change them\./);
    assert.match(seen, /No document is open\./);
  });

  test("attachments become image, PDF and text content blocks", async () => {
    const { chat } = await newChat();
    await saveUpload("img1", "png", new Uint8Array([137, 80, 78, 71]));
    await saveUpload("notes1", "txt", new TextEncoder().encode("Remember the tent."));
    await saveUpload("brief1", "pdf", new TextEncoder().encode("%PDF-1.4"));
    let blocks: Array<Record<string, unknown>> = [];
    claude.script((turn) => {
      blocks = turn.blocks;
    });
    await chat.send({
      text: "Use these",
      attachments: [
        { id: "img1", name: "map.png", mime: "image/png", size: 4, kind: "image" },
        { id: "notes1", name: "notes.txt", mime: "text/plain", size: 18, kind: "text" },
        { id: "brief1", name: "brief.pdf", mime: "application/pdf", size: 8, kind: "pdf" },
        { id: "gone1", name: "old.txt", mime: "text/plain", size: 1, kind: "text" },
      ],
    });
    await idle(chat);
    assert.deepEqual(
      blocks.map((block) => block.type),
      ["text", "image", "text", "document", "text", "text"],
    );
    assert.deepEqual(blocks[1]!.source, { type: "base64", media_type: "image/png", data: Buffer.from([137, 80, 78, 71]).toString("base64") });
    assert.equal(blocks[2]!.text, '<attachment name="notes.txt">\nRemember the tent.\n</attachment>');
    assert.equal((blocks[3]!.source as { media_type: string }).media_type, "application/pdf");
    assert.match(String(blocks[4]!.text), /Attachment "old\.txt" is no longer available/);
    assert.equal(blocks[5]!.text, "Use these");
  });
});

describe("tool use", () => {
  test("Claude reads then edits through MCP; the edit lands live as a reviewable change", async () => {
    const { doc, chat } = await newChat();
    const events = record(chat);
    const docEvents: string[] = [];
    doc.subscribe((event) => docEvents.push(event.type === "activity" ? `activity:${event.activity?.status ?? "idle"}` : event.type));
    let readText = "";
    claude.script(async (turn) => {
      readText = (await turn.tool("mcp__inline__read_document", {})).text;
      const edit = await turn.tool("mcp__inline__edit_document", { old_string: "Monday", new_string: "Saturday morning" });
      assert.equal(edit.isError, false, edit.text);
      turn.say("Moved the trip to Saturday morning.");
    });
    await chat.send({ text: "We now leave Saturday morning." });
    await idle(chat);

    assert.match(readText, /We leave on Monday\./);
    assert.match(markdownOf(doc), /We leave on Saturday morning\./);
    assert.equal(doc.hunks.length, 1);
    assert.equal(doc.hunks[0]!.author, chat.state.id, "the change is attributed to this chat");

    const assistant = lastAssistant(chat);
    const tools = assistant.parts.filter((part): part is ToolPart => part.type === "tool");
    assert.deepEqual(
      tools.map((part) => [part.name, part.status]),
      [
        ["mcp__inline__read_document", "done"],
        ["mcp__inline__edit_document", "done"],
      ],
    );
    assert.deepEqual(tools[1]!.input, { old_string: "Monday", new_string: "Saturday morning" });
    assert.match(tools[1]!.result!, /Edited in "Trip"/);
    assert.deepEqual(assistant.changes, [{ documentId: doc.id, title: "Trip", tool: "edit_document", added: 2, removed: 1 }]);

    const change = events.find((event) => event.type === "change");
    assert.ok(change, "a change event reaches the panel");
    assert.ok(events.some((event) => event.type === "tool_input_delta"), "tool input streams");
    const statuses = events.filter((event) => event.type === "status").map((event) => (event as { status: { kind: string } | null }).status?.kind ?? null);
    assert.ok(statuses.includes("tool"), statuses.join(","));
    assert.equal(statuses.at(-1), null);

    assert.ok(docEvents.includes("activity:thinking"), docEvents.join(","));
    assert.ok(docEvents.includes("activity:reading"), docEvents.join(","));
    assert.ok(docEvents.includes("activity:editing"), docEvents.join(","));
    await waitFor(() => docEvents.at(-1) === "activity:idle", "activity to clear");
  });

  test("a checkpoint version is saved once, before the turn's first edit", async () => {
    const { doc, chat } = await newChat();
    claude.script(async (turn) => {
      await turn.tool("mcp__inline__edit_document", { old_string: "Monday", new_string: "Tuesday" });
      await turn.tool("mcp__inline__edit_document", { old_string: "Pack light.", new_string: "Pack warm clothes." });
      await turn.tool("mcp__inline__insert_content", { content: "Bring snacks.", position: "end" });
    });
    await chat.send({ text: "Three edits" });
    await idle(chat);
    const versions = await doc.versions();
    assert.deepEqual(
      versions.map((version) => [version.label, version.author]),
      [["Before Claude's edits", "auto"]],
    );
    assert.deepEqual(lastAssistant(chat).changes!.length, 1, "changes to one document aggregate");
    assert.equal(lastAssistant(chat).changes![0]!.tool, "insert_content");
  });

  test("the checkpoint captures the text from before Claude's edits", async () => {
    const { doc, chat } = await newChat();
    claude.script(async (turn) => {
      await turn.tool("mcp__inline__write_document", { content: "Totally new." });
    });
    await chat.send({ text: "Rewrite it" });
    await idle(chat);
    const [checkpoint] = await doc.versions();
    assert.equal(checkpoint!.label, "Before Claude's edits");
    const { readVersion } = await import("@/lib/server/store");
    const { loadDoc } = await import("@/lib/server/hub");
    const { docToMarkdown } = await import("@/lib/doc/markdown");
    const stored = await readVersion(doc.id, checkpoint!.id);
    assert.equal(docToMarkdown(loadDoc(stored!.doc)), NOTE);
  });

  test("in Ask mode the tools refuse to write and the document is untouched", async () => {
    const { doc, chat } = await newChat(NOTE, { mode: "ask" });
    let result = { text: "", isError: false };
    claude.script(async (turn) => {
      result = await turn.tool("mcp__inline__edit_document", { old_string: "Monday", new_string: "Tuesday" });
      turn.say("I can't edit in Ask mode.");
    });
    await chat.send({ text: "Change Monday to Tuesday" });
    await idle(chat);
    assert.equal(result.isError, true);
    assert.match(result.text, /Ask mode/);
    assert.equal(markdownOf(doc), NOTE);
    const tool = lastAssistant(chat).parts.find((part): part is ToolPart => part.type === "tool")!;
    assert.equal(tool.status, "error");
    assert.equal(lastAssistant(chat).status, "done");
    assert.equal((await doc.versions()).length, 0, "no checkpoint without a write");
  });

  test("switching to Ask mode between turns applies to the live session", async () => {
    const { doc, chat } = await newChat();
    await chat.send({ text: "warm up" });
    await idle(chat);
    await chat.update({ settings: { mode: "ask" } });
    let result = { text: "", isError: false };
    claude.script(async (turn) => {
      result = await turn.tool("mcp__inline__write_document", { content: "Gone." });
    });
    await chat.send({ text: "Rewrite" });
    await idle(chat);
    assert.equal(claude.calls.filter((call) => call.options.sessionId === chat.state.id || call.options.resume === chat.state.id).length, 1, "same session");
    assert.equal(result.isError, true);
    assert.equal(markdownOf(doc), NOTE);
  });

  test("attaching the chat to another document retargets the tools", async () => {
    const { chat } = await newChat();
    const other = await hub.create({ title: "Budget", markdown: "Total: 100." });
    claude.script(async (turn) => {
      await turn.tool("mcp__inline__edit_document", { old_string: "100", new_string: "120" });
    });
    await chat.send({ text: "Raise it", documentId: other.id });
    await idle(chat);
    assert.equal(chat.state.documentId, other.id);
    assert.equal(markdownOf(other), "Total: 120.");
  });

  test("TodoWrite updates the chat's todo list", async () => {
    const { chat } = await newChat();
    const events = record(chat);
    claude.script(async (turn) => {
      await turn.tool("TodoWrite", {
        todos: [
          { content: "Read the draft", activeForm: "Reading the draft", status: "completed" },
          { content: "Tighten the intro", activeForm: "Tightening the intro", status: "in_progress" },
        ],
      });
    });
    await chat.send({ text: "Plan it" });
    await idle(chat);
    assert.deepEqual(
      chat.state.todos.map((todo) => [todo.content, todo.status]),
      [
        ["Read the draft", "completed"],
        ["Tighten the intro", "in_progress"],
      ],
    );
    assert.ok(events.some((event) => event.type === "todos"));
  });

  test("a failed tool shows as an error part, and the turn still completes", async () => {
    const { chat } = await newChat();
    claude.script(async (turn) => {
      await turn.tool("mcp__inline__edit_document", { old_string: "Wednesday", new_string: "Thursday" });
      turn.say("That text isn't in the document.");
    });
    await chat.send({ text: "Change Wednesday" });
    await idle(chat);
    const tool = lastAssistant(chat).parts.find((part): part is ToolPart => part.type === "tool")!;
    assert.equal(tool.status, "error");
    assert.match(tool.result!, /not found/);
    assert.equal(lastAssistant(chat).status, "done");
  });

  test("subagent messages are not shown as the main transcript", async () => {
    const { chat } = await newChat();
    claude.script((turn) => {
      turn.emit({ type: "assistant", parent_tool_use_id: "toolu_task", message: { id: "sub", content: [{ type: "text", text: "inner monologue" }] } });
      turn.say("Visible answer.");
    });
    await chat.send({ text: "go" });
    await idle(chat);
    const texts = lastAssistant(chat).parts.filter((part) => part.type === "text").map((part) => (part as { text: string }).text);
    assert.deepEqual(texts, ["Visible answer."]);
  });
});

describe("queueing, interrupting and retrying", () => {
  test("messages sent while Claude is working queue and run in order", async () => {
    const { chat } = await newChat();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    claude.script(
      async (turn) => {
        order.push(turn.texts.at(-1)!);
        await gate;
        turn.say("first done");
      },
      (turn) => {
        order.push(turn.texts.at(-1)!);
        turn.say("second done");
      },
    );
    await chat.send({ text: "first" });
    const queued = await chat.send({ text: "second" });
    assert.equal(queued.queued, true);
    assert.deepEqual(
      chat.state.queue.map((item) => item.text),
      ["second"],
    );
    release();
    await waitFor(() => chat.state.messages.length === 4 && !chat.state.running && lastAssistant(chat).status === "done", "both turns");
    assert.deepEqual(order, ["first", "second"]);
    assert.equal(chat.state.queue.length, 0);
  });

  test("a queued message can be removed before it runs", async () => {
    const { chat } = await newChat();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    claude.script(async (turn) => {
      await gate;
      turn.say("done");
    });
    await chat.send({ text: "first" });
    const queued = await chat.send({ text: "never mind" });
    chat.removeQueued(queued.id);
    release();
    await idle(chat);
    assert.equal(chat.state.messages.length, 2);
  });

  test("interrupt stops the turn and clears the queue", async () => {
    const { chat } = await newChat();
    claude.script(async (turn) => {
      turn.say("Working on a long answer");
      await turn.waitForInterrupt();
      turn.stopped();
    });
    await chat.send({ text: "write a novel" });
    await chat.send({ text: "queued behind it" });
    await waitFor(() => lastAssistant(chat).parts.length > 0, "streaming to start");
    await chat.interrupt();
    await idle(chat);
    assert.equal(lastAssistant(chat).status, "stopped");
    assert.equal(lastAssistant(chat).error, undefined);
    assert.equal(chat.state.queue.length, 0);
    assert.equal(chat.state.messages.length, 2, "the queued message did not run");
  });

  test("retry re-runs the last message after an error", async () => {
    const { chat } = await newChat();
    claude.script(
      (turn) => turn.fail("error_during_execution", ["socket hang up"]),
      (turn) => turn.say("Second time lucky."),
    );
    await chat.send({ text: "try this" });
    await idle(chat);
    assert.equal(lastAssistant(chat).status, "error");
    assert.match(lastAssistant(chat).error!, /socket hang up/);
    await chat.retry();
    await idle(chat);
    assert.equal(chat.state.messages.length, 2, "the failed exchange is replaced, not duplicated");
    assert.equal((chat.state.messages[0] as UserMessage).text, "try this");
    assert.equal(lastAssistant(chat).status, "done");
  });
});

describe("failures are explained in plain language", () => {
  test("an authentication error from the API", async () => {
    const { chat } = await newChat();
    claude.script((turn) => {
      turn.apiError("authentication_failed");
      turn.succeed();
    });
    await chat.send({ text: "hi" });
    await idle(chat);
    assert.equal(lastAssistant(chat).status, "error");
    assert.match(lastAssistant(chat).error!, /Claude Code is not signed in/);
  });

  test("a rate limit", async () => {
    const { chat } = await newChat();
    claude.script((turn) => {
      turn.apiError("rate_limit");
      turn.fail("error_during_execution");
    });
    await chat.send({ text: "hi" });
    await idle(chat);
    assert.match(lastAssistant(chat).error!, /usage limit/);
  });

  test("hitting the turn limit", async () => {
    const { chat } = await newChat();
    claude.script((turn) => turn.fail("error_max_turns"));
    await chat.send({ text: "hi" });
    await idle(chat);
    assert.equal(lastAssistant(chat).error, "Stopped after reaching the turn limit.");
  });

  test("Claude Code not being installed", async () => {
    const { chat } = await newChat();
    claude.crash = new Error("spawn claude ENOENT");
    await chat.send({ text: "hi" });
    await idle(chat);
    assert.equal(lastAssistant(chat).status, "error");
    assert.match(lastAssistant(chat).error!, /couldn't start Claude Code/);
  });

  test("Claude Code exiting mid-turn, then recovering on the next message", async () => {
    const { chat } = await newChat();
    claude.script((turn) => {
      turn.say("Starting");
      turn.crash(new Error("Not logged in · Please run /login"));
    });
    await chat.send({ text: "hi" });
    await idle(chat);
    assert.match(lastAssistant(chat).error!, /not signed in/);
    assert.equal(chat.live, false);
    claude.script((turn) => turn.say("Back."));
    await chat.send({ text: "again" });
    await idle(chat);
    assert.equal(lastAssistant(chat).status, "done");
    assert.equal(claude.lastCall.options.resume, chat.state.id, "the new process resumes the same Claude Code session");
  });

  test("API retries show as a retrying status", async () => {
    const { chat } = await newChat();
    const events = record(chat);
    claude.script((turn) => {
      turn.emit({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 5, retry_delay_ms: 500, error: "overloaded" });
      turn.say("ok");
    });
    await chat.send({ text: "hi" });
    await idle(chat);
    const retry = events.find((event) => event.type === "status" && (event as { status: { kind: string } | null }).status?.kind === "retrying") as { status: { error: string; attempt: number } } | undefined;
    assert.ok(retry);
    assert.equal(retry.status.attempt, 1);
    assert.match(retry.status.error, /overloaded right now/);
  });

  test("rate-limit notices reach the panel", async () => {
    const { chat } = await newChat();
    const events = record(chat);
    claude.script((turn) => {
      turn.emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1_900_000_000, rateLimitType: "five_hour", utilization: 0.9 } });
      turn.say("ok");
    });
    await chat.send({ text: "hi" });
    await idle(chat);
    const notice = events.find((event) => event.type === "rate_limit") as { rateLimit: { status: string; utilization: number } } | undefined;
    assert.deepEqual(notice?.rateLimit, { status: "allowed_warning", resetsAt: 1_900_000_000, type: "five_hour", utilization: 0.9 });
  });
});

describe("sessions and persistence", () => {
  test("follow-up messages reuse the live Claude Code process", async () => {
    const { chat } = await newChat();
    const before = claude.calls.length;
    await chat.send({ text: "one" });
    await idle(chat);
    await chat.send({ text: "two" });
    await idle(chat);
    assert.equal(claude.calls.length - before, 1);
    assert.equal(claude.lastCall.inputs.length, 2);
  });

  test("model and effort changes apply to the live session", async () => {
    const { chat } = await newChat();
    await chat.send({ text: "one" });
    await idle(chat);
    const q = claude.lastCall.query;
    await chat.update({ settings: { model: "claude-test-haiku", effort: "low" } });
    assert.equal(q.model, "claude-test-haiku");
    assert.deepEqual(q.flagSettings, [{ effortLevel: "low" }]);
    assert.equal(chat.state.settings.model, "claude-test-haiku");
  });

  test("a closed session resumes from Claude Code's transcript", async () => {
    const { chat } = await newChat();
    await chat.send({ text: "one" });
    await idle(chat);
    chat.close();
    assert.equal(chat.live, false);
    await chat.send({ text: "two" });
    await idle(chat);
    assert.equal(claude.lastCall.options.resume, chat.state.id);
    assert.equal(claude.lastCall.options.sessionId, undefined);
  });

  test("chats are saved to disk and survive a restart", async () => {
    const { chat } = await newChat();
    claude.script((turn) => turn.say("Saved answer."));
    await chat.send({ text: "remember me" });
    await idle(chat);
    await chat.persistNow();
    const file = JSON.parse(readFileSync(path.join(dataDir, "chats", `${chat.state.id}.json`), "utf8"));
    assert.equal(file.format, 1);
    assert.equal(file.sessionStarted, true);
    assert.equal(file.messages.length, 2);
    assert.equal(file.messages[1].parts[0].text, "Saved answer.");
  });

  test("a turn cut off by a restart loads as stopped, with running tools marked failed", async () => {
    const { writeChatFile } = await import("@/lib/server/store");
    const id = "restarted-chat";
    await writeChatFile(id, {
      format: 1,
      id,
      title: "Restarted",
      documentId: null,
      createdAt: 1,
      updatedAt: 1,
      settings: { model: null, effort: "medium", mode: "agent" },
      todos: [],
      sessionStarted: true,
      messages: [
        { id: "u", role: "user", text: "hi", createdAt: 1 },
        { id: "a", role: "assistant", createdAt: 1, status: "streaming", parts: [{ type: "tool", id: "t", name: "mcp__inline__read_document", input: {}, status: "running" }] },
      ],
    });
    const chat = (await runtime.get(id))!;
    const assistant = lastAssistant(chat);
    assert.equal(assistant.status, "stopped");
    assert.equal(assistant.error, "Interrupted when Inline restarted.");
    assert.equal((assistant.parts[0] as ToolPart).status, "error");
    assert.equal(chat.state.running, false);
  });

  test("reconnecting clients get missed events, or a snapshot when too far behind", async () => {
    const { chat } = await newChat();
    await chat.send({ text: "one" });
    await idle(chat);
    const seq = chat.state.messages.length && (await new Promise<number>((resolve) => chat.subscribe((event) => resolve(event.seq))));
    claude.script((turn) => turn.say("two"));
    await chat.send({ text: "two" });
    await idle(chat);
    const replay: SequencedChatEvent[] = [];
    chat.subscribe((event) => replay.push(event), seq);
    assert.notEqual(replay[0]!.type, "snapshot");
    assert.ok(replay.every((event) => event.seq > seq));
    const fresh: SequencedChatEvent[] = [];
    chat.subscribe((event) => fresh.push(event), 10_000_000);
    assert.equal(fresh[0]!.type, "snapshot");
  });

  test("list shows chats with messages, filtered by document, newest first; remove deletes", async () => {
    const { doc, chat } = await newChat();
    await runtime.create({ documentId: doc.id });
    await chat.send({ text: "listed" });
    await idle(chat);
    const listed = await runtime.list({ documentId: doc.id });
    assert.deepEqual(
      listed.map((summary) => summary.id),
      [chat.state.id],
      "empty chats are hidden",
    );
    await runtime.remove(chat.state.id);
    assert.equal(await runtime.get(chat.state.id), null);
  });

  test("at most six idle Claude Code processes stay alive", async () => {
    const chats: ChatRuntime[] = [];
    for (let i = 0; i < 8; i += 1) {
      const { chat } = await newChat();
      await chat.send({ text: `chat ${i}` });
      await idle(chat);
      chats.push(chat);
    }
    const live = [...(runtime as unknown as { chats: Map<string, ChatRuntime> }).chats.values()].filter((chat) => chat.live);
    assert.ok(live.length <= 6, `${live.length} live sessions`);
    assert.equal(chats.at(-1)!.live, true, "the newest stays live");
    assert.equal(chats[0]!.live, false, "the least recently used is closed");
  });
});

describe("Claude Code status probe", () => {
  test("reports ready with the account's models", async () => {
    claude.init = { account: { email: "writer@example.com", subscriptionType: "max" }, models: [{ value: "default", displayName: "Default", description: "Recommended", supportedEffortLevels: ["low", "medium", "high"] }] };
    const status = await runtime.agentStatus(true);
    assert.equal(status.state, "ready");
    if (status.state !== "ready") return;
    assert.equal(status.account.email, "writer@example.com");
    assert.deepEqual(status.models[0], { value: "default", displayName: "Default", description: "Recommended", efforts: ["low", "medium", "high"] });
    assert.equal(status.defaultModel, "default");
  });

  test("reports signed out when Claude Code has no account", async () => {
    claude.init = { account: {}, models: [] };
    const status = await runtime.agentStatus(true);
    assert.equal(status.state, "signed_out");
  });

  test("reports unavailable when Claude Code can't start", async () => {
    claude.init = new Error("spawn claude ENOENT");
    const status = await runtime.agentStatus(true);
    assert.equal(status.state, "unavailable");
    assert.match(status.state === "unavailable" ? status.message : "", /couldn't start Claude Code/);
  });

  test("results are cached until forced", async () => {
    claude.init = { account: { email: "a@example.com" }, models: [] };
    const first = await runtime.agentStatus(true);
    claude.init = { account: {}, models: [] };
    const cached = await runtime.agentStatus();
    assert.equal(cached, first);
  });
});

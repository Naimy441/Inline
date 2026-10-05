import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

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
  (await import("@/lib/agent/runtime")).setQueryImplementation(claude.query as never);
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

describe("session setup", () => {
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
  test("Word files arrive as readable Markdown and SVG images as their source", async () => {
    const { chat } = await newChat();
    const { documentToDocx } = await import("@/lib/doc/docx");
    const { markdownToDoc } = await import("@/lib/doc/markdown");
    const { DEFAULT_SETTINGS } = await import("@/lib/doc/settings");
    const docx = await documentToDocx(markdownToDoc("# Brief\n\nKeep it **short**."), { id: "x", title: "Brief", createdAt: 0, updatedAt: 0, lastOpenedAt: 0, trashedAt: null, settings: DEFAULT_SETTINGS, wordCount: 0, preview: "" }, async () => null);
    await saveUpload("word1", "docx", docx);
    await saveUpload("broken1", "docx", new TextEncoder().encode("not really a docx"));
    await saveUpload("svg1", "svg", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'));
    let blocks: Array<Record<string, unknown>> = [];
    claude.script((turn) => {
      blocks = turn.blocks;
    });
    await chat.send({
      text: "Read these",
      attachments: [
        { id: "word1", name: "brief.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: docx.length, kind: "text" },
        { id: "broken1", name: "bad.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 17, kind: "text" },
        { id: "svg1", name: "dot.svg", mime: "image/svg+xml", size: 60, kind: "image" },
      ],
    });
    await idle(chat);
    assert.deepEqual(blocks.map((block) => block.type), ["text", "text", "text", "text", "text"]);
    assert.equal(blocks[1]!.text, '<attachment name="brief.docx">\n# Brief\n\nKeep it **short**.\n</attachment>');
    assert.match(String(blocks[2]!.text), /couldn't be read/);
    assert.match(String(blocks[3]!.text), /<circle r="4"\/>/);
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
});

describe("sessions and persistence", () => {
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

describe("reviewing one turn's changes", () => {
  test("each turn's edits are tagged with that turn, so its card can't touch the user's suggestions or other turns", async () => {
    const { doc, chat } = await newChat("# Trip {.title}\n\nWe leave on Monday.\n\nPack light.\n\nBring a map.");
    claude.script(async (turn) => {
      await turn.tool("mcp__inline__edit_document", { old_string: "Monday", new_string: "Tuesday" });
      turn.say("Done.");
    });
    await chat.send({ text: "Change the day." });
    await idle(chat);
    const firstTurn = lastAssistant(chat).id;

    claude.script(async (turn) => {
      await turn.tool("mcp__inline__edit_document", { old_string: "Pack light.", new_string: "Pack very light." });
      turn.say("Done.");
    });
    await chat.send({ text: "Stress packing light." });
    await idle(chat);
    const secondTurn = lastAssistant(chat).id;

    // The user's own suggestion (suggesting mode) is pending too.
    const { Transform } = await import("prosemirror-transform");
    const { schema } = await import("@/lib/doc/schema");
    const at = doc.doc.textContent.indexOf("Bring");
    let pos = 0;
    doc.doc.descendants((node, offset) => {
      if (!pos && node.isText && node.text!.startsWith("Bring")) pos = offset;
      return !pos;
    });
    assert.ok(at >= 0 && pos > 0);
    const tr = new Transform(doc.doc).insert(pos, schema.text("Also: "));
    doc.receiveClientSteps(doc.version, tr.steps.map((step) => step.toJSON()), "tab", { suggest: true });

    const turns = doc.hunksJSON().map((hunk) => [hunk.insertedText, hunk.turn ?? null]);
    assert.deepEqual(
      turns.sort(),
      [
        ["Also: ", null],
        ["very ", secondTurn],
        ["Tuesday", firstTurn],
      ].sort(),
    );

    // Undo just the second turn: the first turn's edit and the user's suggestion stay pending.
    const secondIds = doc.hunks.filter((hunk) => hunk.turn === secondTurn).map((hunk) => hunk.id);
    doc.review("reject", secondIds);
    assert.match(markdownOf(doc), /Pack light\./);
    assert.match(markdownOf(doc), /Tuesday/);
    assert.equal(doc.hunks.length, 2);
  });
});

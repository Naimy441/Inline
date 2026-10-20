import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
process.env.INLINE_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "inline-codex-"));

import { setCodexConnectionFactory } from "./codexRpc";
import { codexAccount, codexPlanUsage } from "./codexAccount";
import { codexInput, codexTools } from "./codexSession";
import { fakeCodex, type FakeCodexModel } from "./testing/fakeCodex";
import { fakeClaude } from "./testing/fakeClaude";
import { agentRuntime, setQueryImplementation, usageLimitReason, type ChatRuntime } from "./runtime";
import { TOOLS } from "./tools";
import { documentHub } from "@/lib/server/hub";
import { docToMarkdown } from "@/lib/doc/markdown";
import { readChatFile } from "@/lib/server/store";
import type { AssistantMessage, ChatEvent, ChatSettings } from "./types";
import { conversationHandoff } from "./providers";
import { SettingsPatchSchema } from "./schemas";

const chats: ChatRuntime[] = [];
afterEach(() => { for (const chat of chats.splice(0)) chat.close(); setCodexConnectionFactory(null); setQueryImplementation(null); });
async function setup(model?: FakeCodexModel, settings: Partial<ChatSettings> = {}) {
  const fake = fakeCodex(model);
  setCodexConnectionFactory(fake.factory);
  await codexAccount().planUsage(true);
  const doc = await documentHub().create({ title: "Codex notes", markdown: "The quick brown fox jumps over the lazy dog." });
  const chat = await agentRuntime().create({ documentId: doc.id, settings: { provider: "codex", model: "codex-test", effort: "medium", mode: "agent", ...settings } });
  chats.push(chat);
  return { fake, doc, chat };
}
function idle(chat: ChatRuntime) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("Chat didn't finish")); }, 10_000);
    const off = chat.subscribe((event) => { if (event.type === "running" && !event.running) { clearTimeout(timer); off(); resolve(); } });
  });
}
async function turn(chat: ChatRuntime, text: string) {
  const done = idle(chat);
  await chat.send({ text });
  await done;
  return chat.state.messages.at(-1) as AssistantMessage;
}

describe("Codex integration", () => {
  it("discovers account models and their supported efforts", async () => {
    await setup();
    const status = await agentRuntime().agentStatus(true, "codex");
    assert.equal(status.state, "ready");
    if (status.state !== "ready") return;
    assert.equal(status.defaultModel, "codex-test");
    assert.deepEqual(status.models[0]?.efforts, ["medium", "high"]);
    assert.equal(status.models[0]?.provider, "codex");
  });
  it("distinguishes signed-out accounts", async () => {
    const { fake } = await setup();
    fake.setSignedIn(false);
    assert.equal((await codexAccount().agentStatus(true)).state, "signed_out");
  });
  it("deduplicates browser sign-in and supports completion and cancellation", async () => {
    const { fake } = await setup();
    await Promise.all([codexAccount().startLogin(), codexAccount().startLogin()]);
    assert.equal(codexAccount().loginStatus().state, "waiting");
    assert.equal(fake.requests.filter((request) => request.method === "account/login/start").length, 1);
    fake.completeLogin(true);
    assert.equal(codexAccount().loginStatus().state, "done");
    await codexAccount().startLogin();
    await codexAccount().cancelLogin();
    assert.equal(codexAccount().loginStatus().state, "idle");
    assert.equal(fake.requests.filter((request) => request.method === "account/login/cancel").length, 1);
  });
  it("attributes Codex comments, replies, review hunks and saved versions correctly", async () => {
    const { chat, doc } = await setup(async (_turn, agent) => {
      const added = await agent.call("add_comment", { text: "quick brown fox", comment: "Check this phrase." });
      const id = added.contentItems.map((item) => item.text ?? "").join("").match(/Added comment (\S+) on/)?.[1];
      await agent.call("reply_to_comment", { comment_id: id, reply: "Checked." });
      await agent.call("edit_document", { old_string: "quick", new_string: "clever" });
      await agent.call("save_version", { label: "Codex review" });
    });
    await turn(chat, "Comment and save");
    assert.equal(doc.comments[0]?.author, "codex");
    assert.equal(doc.comments[0]?.replies[0]?.author, "codex");
    assert.ok(doc.hunks.every((hunk) => hunk.author.startsWith("codex:")));
    assert.equal((await doc.versions()).find((version) => version.label === "Codex review")?.author, "codex");
  });
  it("exposes every existing Inline tool with JSON schemas", () => {
    const tools = codexTools();
    assert.equal(tools.length, TOOLS.length + 1);
    for (const tool of TOOLS) {
      const spec = tools.find((item) => item.name === tool.name);
      assert.ok(spec, tool.name);
      assert.equal(spec.inputSchema.type, "object");
    }
  });
  it("streams text and reasoning, records tokens/context and persists a resume id", async () => {
    const { chat } = await setup((_turn, agent) => { agent.think("Reading the document."); agent.say("Here is your summary."); });
    const events: ChatEvent[] = [];
    chat.subscribe((event) => events.push(structuredClone(event)));
    const reply = await turn(chat, "Summarize");
    assert.equal(reply.status, "done");
    assert.equal(reply.provider, "codex");
    assert.equal(reply.model, "codex-test");
    assert.equal(reply.parts.filter((part) => part.type === "text").map((part) => part.text).join(""), "Here is your summary.");
    assert.ok(events.some((event) => event.type === "text_delta"));
    assert.ok(events.some((event) => event.type === "thinking_delta"));
    assert.equal(reply.usage?.inputTokens, 100);
    assert.equal(reply.usage?.costUnavailable, true);
    assert.equal(chat.state.context?.maxTokens, 200_000);
    await chat.persistNow();
    const saved = await readChatFile<{ codexThreadId: string; messages: unknown[] }>(chat.state.id);
    assert.ok(saved?.codexThreadId);
    assert.equal(saved.messages.length, 2);
  });
  it("makes real reviewable edits with checkpoints and document logs", async () => {
    const { chat, doc } = await setup();
    const reply = await turn(chat, 'replace "quick brown fox" with "clever red fox"');
    assert.equal(reply.status, "done", reply.error ?? "");
    assert.match(docToMarkdown(doc.doc), /clever red fox/);
    assert.ok(doc.hunks.length);
    assert.ok(reply.changes?.[0]?.checkpoint);
    assert.match(reply.documentLog?.[0]?.after ?? "", /clever red fox/);
    assert.ok(reply.parts.some((part) => part.type === "tool" && part.name === "mcp__inline__edit_document" && part.status === "done"));
  });
  it("enforces Ask mode through the same tools", async () => {
    const { chat, doc } = await setup(undefined, { mode: "ask" });
    await turn(chat, 'replace "quick" with "clever"');
    assert.match(docToMarkdown(doc.doc), /quick/);
    const reply = chat.state.messages.at(-1) as AssistantMessage;
    assert.ok(reply.parts.some((part) => part.type === "tool" && part.name.endsWith("edit_document") && part.status === "error"));
  });
  it("warms a Codex session without inference and reuses it for the first message", async () => {
    const { chat, fake } = await setup();
    assert.equal(chat.warm(), true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fake.turns.length, 0);
    assert.equal(chat.live, true);
    await turn(chat, "First message");
    assert.equal(fake.requests.filter((request) => request.method === "thread/start").length, 1);
  });
  it("resumes after idle close instead of losing its thread", async () => {
    const { chat, fake } = await setup();
    await turn(chat, "First");
    chat.close();
    await turn(chat, "Second");
    assert.equal(fake.requests.filter((request) => request.method === "thread/start").length, 1);
    assert.equal(fake.requests.filter((request) => request.method === "thread/resume").length, 1);
    assert.equal(fake.turns[0]?.threadId, fake.turns[1]?.threadId);
    assert.equal((chat.state.messages.at(-1) as AssistantMessage).usage?.inputTokens, 100);
  });
  it("switches Claude → Codex → Claude with shared history and preserves Claude's native tools", async () => {
    const { chat, fake } = await setup();
    const claude = fakeClaude((_turn, agent) => agent.say("The secret word is persimmon."));
    setQueryImplementation(claude.query);
    await chat.update({ settings: { provider: "claude", model: null } });
    await turn(chat, "Remember my secret word");
    await chat.update({ settings: { provider: "codex", model: "codex-test" } });
    await turn(chat, "What was the secret word?");
    assert.match(fake.turns[0]!.input.map((block) => block.text ?? "").join(""), /persimmon/);
    await chat.update({ settings: { provider: "claude", model: null } });
    await turn(chat, "Continue the same conversation");
    assert.equal(claude.turns.length, 2);
    assert.match(claude.turns[1]!.context + claude.turns[1]!.text, /Codex can see this conversation/);
    assert.ok(claude.sessions.at(-1)?.options.mcpServers?.inline);
    assert.equal(chat.state.messages.length, 6);
    assert.deepEqual(chat.state.messages.filter((message) => message.role === "assistant").map((message) => message.provider), ["claude", "codex", "claude"]);
  });
  it("queues follow-ups, stops work, and refuses provider changes during a reply", async () => {
    const { chat } = await setup();
    const done = idle(chat);
    await chat.send({ text: "wait for stop" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(chat.update({ settings: { provider: "claude" } }), /Stop the current reply/);
    assert.equal((await chat.send({ text: "Queued" })).queued, true);
    await chat.interrupt();
    await done;
    assert.equal((chat.state.messages.at(-1) as AssistantMessage).status, "stopped");
    assert.equal(chat.state.queue.length, 0);
  });
  it("enforces step limits and leaves no tool running", async () => {
    const { chat } = await setup(async (_turn, agent) => { await agent.call("read_document", {}); await agent.call("read_document", {}); }, { maxTurns: 1 });
    const reply = await turn(chat, "Read twice");
    assert.equal(reply.status, "error");
    assert.match(reply.error ?? "", /step limit/);
    assert.ok(reply.parts.every((part) => part.type !== "tool" || part.status !== "running"));
  });
  it("blocks work at the Codex quota limit", async () => {
    const { chat, fake } = await setup(undefined, { usageLimit: 50 });
    fake.setUsage(60);
    await codexAccount().planUsage(true);
    const reply = await turn(chat, "Do work");
    assert.equal(reply.status, "error");
    assert.match(reply.error ?? "", /Paused at your usage limit/);
    assert.equal(fake.turns.length, 0);
  });
  it("rewinds Codex and replays only kept messages in a new thread", async () => {
    const { chat, fake } = await setup();
    await turn(chat, "Keep this first request");
    const second = await turn(chat, "Remove this second request");
    await chat.rewind(second.id);
    await turn(chat, "New request");
    assert.notEqual(fake.turns[0]?.threadId, fake.turns[2]?.threadId);
    const input = fake.turns[2]!.input.map((block) => block.text ?? "").join("\n");
    assert.match(input, /Keep this first request/);
    assert.doesNotMatch(input, /Remove this second request/);
  });
  it("recovers from a missing provider transcript using shared history", async () => {
    const { chat, fake } = await setup();
    await turn(chat, "Remember pineapple");
    chat.close();
    fake.setFailResume(true);
    assert.equal((await turn(chat, "Follow-up")).status, "error");
    fake.setFailResume(false);
    const reply = await turn(chat, "Try again");
    assert.equal(reply.status, "done");
    assert.match(fake.turns.at(-1)!.input.map((item) => item.text ?? "").join(""), /pineapple/);
  });
  it("renders PDF attachments as text and page images, including scanned pages", async () => {
    const { buildTestPdf } = await import("@/lib/pdf/import/testPdf");
    const data = buildTestPdf([{ content: "BT /F1 12 Tf 72 700 Td (Attachment contents) Tj ET" }, { content: "0 0 0 rg 20 20 40 40 re f" }]);
    const input = await codexInput({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(data).toString("base64") }, title: "Source.pdf" }] } });
    assert.equal(input.filter((item) => item.type === "image").length, 2);
    assert.match(input.filter((item) => item.type === "text").map((item) => item.text).join(""), /Attachment contents/);
    assert.ok(input.filter((item) => item.type === "image").every((item) => String(item.url).startsWith("data:image/png;base64,")));
  });
  it("converts images and text to native Codex input", async () => {
    const input = await codexInput({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "Look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }] } });
    assert.deepEqual(input, [{ type: "text", text: "Look", text_elements: [] }, { type: "image", url: "data:image/png;base64,abc" }]);
  });
});

describe("provider usage and migration", () => {
  it("keeps multi-bucket quotas, durations and reset times without double counting legacy data", () => {
    const usage = codexPlanUsage({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: { codex: { planType: "pro", primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1000 }, secondary: { usedPercent: 70, windowDurationMins: 10080 } }, other: { primary: { usedPercent: 20, windowDurationMins: 60 } } } }, 0);
    assert.equal(usage.available, true);
    if (!usage.available) return;
    assert.equal(usage.windows.length, 3);
    assert.equal(usage.windows[0]?.resetsAt, 1_000_000);
    assert.match(usageLimitReason(usage, 50, 0) ?? "", /70%/);
    assert.equal(usageLimitReason(codexPlanUsage({}, 0), 50, 0), null);
  });
  it("merges sparse rate-limit events without dropping other quota buckets or plan metadata", () => {
    codexAccount().noteUsage({ rateLimitsByLimitId: { codex: { planType: "pro", primary: { usedPercent: 10 }, secondary: { usedPercent: 20 } }, other: { primary: { usedPercent: 30 } } } });
    const usage = codexAccount().noteRateLimit({ limitId: "codex", planType: null, primary: { usedPercent: 40 }, secondary: null });
    assert.equal(usage.available, true);
    if (!usage.available) return;
    assert.equal(usage.plan, "pro");
    assert.deepEqual(usage.windows.map((window) => window.utilization), [40, 20, 30]);
  });
  it("accepts both provider settings and preserves old chats as Claude", () => {
    assert.deepEqual(SettingsPatchSchema.parse({ provider: "codex", model: null, effort: "ultra" }), { provider: "codex", model: null, effort: "ultra" });
    assert.equal(SettingsPatchSchema.safeParse({ provider: "bogus" }).success, false);
    assert.equal(conversationHandoff([]), "");
  });
});

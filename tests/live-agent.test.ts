import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";

import type { AssistantMessage, ToolPart } from "@/lib/agent/types";
import type { ChatRuntime } from "@/lib/agent/runtime";

import { useTempDataDir } from "./support/mcp";

/**
 * The real thing: Inline's agent runtime driving the installed, signed-in
 * Claude Code, and an external Claude Code connected to /api/mcp over HTTP.
 * These cost model calls and need a login, so they only run with
 * INLINE_LIVE_AGENT=1 (optionally INLINE_LIVE_MODEL, default "haiku").
 */

const LIVE = process.env.INLINE_LIVE_AGENT === "1";
const MODEL = process.env.INLINE_LIVE_MODEL || "haiku";
const dataDir = useTempDataDir("inline-live-");
const run = promisify(execFile);

describe("live Claude Code", { skip: LIVE ? false : "set INLINE_LIVE_AGENT=1 to run against a signed-in Claude Code", timeout: 300_000 }, () => {
  let runtime: ReturnType<typeof import("@/lib/agent/runtime").agentRuntime>;
  let hub: ReturnType<typeof import("@/lib/server/hub").documentHub>;
  let docToMarkdown: typeof import("@/lib/doc/markdown").docToMarkdown;
  const chats: ChatRuntime[] = [];

  before(async () => {
    runtime = (await import("@/lib/agent/runtime")).agentRuntime();
    hub = (await import("@/lib/server/hub")).documentHub();
    docToMarkdown = (await import("@/lib/doc/markdown")).docToMarkdown;
  });

  after(() => {
    for (const chat of chats) chat.close();
  });

  async function turn(chat: ChatRuntime, text: string, extra: Partial<Parameters<ChatRuntime["send"]>[0]> = {}) {
    await chat.send({ text, ...extra });
    const start = Date.now();
    while (chat.state.running || (chat.state.messages.at(-1) as AssistantMessage).status === "streaming") {
      if (Date.now() - start > 240_000) throw new Error("Claude did not finish in time");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return chat.state.messages.at(-1) as AssistantMessage;
  }

  test("the status probe finds a signed-in Claude Code", async () => {
    const status = await runtime.agentStatus(true);
    assert.equal(status.state, "ready", JSON.stringify(status));
  });

  test("the in-app agent edits a document through MCP and the change is reviewable", async () => {
    const doc = await hub.create({ title: "Trip", markdown: "# Trip {.title}\n\nWe leave on Monday.\n\nPack light." });
    const chat = await runtime.create({ documentId: doc.id, settings: { model: MODEL, effort: "low", mode: "agent" } });
    chats.push(chat);
    const message = await turn(chat, "Change the departure day in the document from Monday to Tuesday. Change nothing else.");
    assert.equal(message.status, "done", message.error ?? "");
    assert.match(docToMarkdown(doc.doc), /We leave on Tuesday\./);
    assert.match(docToMarkdown(doc.doc), /Pack light\./);
    assert.ok(doc.hunks.length >= 1);
    assert.ok(doc.hunks.every((hunk) => hunk.author === chat.state.id));
    const tools = message.parts.filter((part): part is ToolPart => part.type === "tool").map((part) => part.name);
    assert.ok(tools.some((name) => /^mcp__inline__(edit_document|multi_edit_document|write_document)$/.test(name)), tools.join(", "));
    assert.ok(message.changes?.some((change) => change.documentId === doc.id));
    const versions = await doc.versions();
    assert.ok(versions.some((version) => version.label === "Before Claude's edits"));
  });

  test("in Ask mode Claude answers without changing the document", async () => {
    const doc = await hub.create({ title: "Memo", markdown: "The budget is 40000 dollars." });
    const chat = await runtime.create({ documentId: doc.id, settings: { model: MODEL, effort: "low", mode: "ask" } });
    chats.push(chat);
    const message = await turn(chat, "What is the budget in this document? Answer in one short sentence.");
    assert.equal(message.status, "done", message.error ?? "");
    assert.equal(docToMarkdown(doc.doc), "The budget is 40000 dollars.");
    const text = message.parts.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join(" ");
    assert.match(text, /40,?000/);
  });

  test("a prompt in an empty document drafts it, and undo returns to empty", async () => {
    const doc = await hub.create({ title: "Untitled document", markdown: "" });
    const chat = await runtime.create({ documentId: doc.id, settings: { model: MODEL, effort: "low", mode: "agent" } });
    chats.push(chat);
    const message = await turn(chat, "Write a three-item bulleted packing list for a beach day, under a heading 'Beach day'. Nothing else.");
    assert.equal(message.status, "done", message.error ?? "");
    const text = docToMarkdown(doc.doc);
    assert.match(text, /Beach day/i);
    assert.equal((text.match(/^- /gm) ?? []).length, 3, text);
    assert.doesNotMatch(text, /&nbsp;/);
    doc.review("reject", "all");
    assert.equal(docToMarkdown(doc.doc), "&nbsp;");
  });

  test("a prompt about the selection rewrites only that text", async () => {
    const sentence = "In order to be able to make progress, it is really very important that we all agree on the scope first.";
    const doc = await hub.create({ title: "Scope", markdown: `Keep this intro exactly.\n\n${sentence}\n\nKeep this outro exactly.` });
    const chat = await runtime.create({ documentId: doc.id, settings: { model: MODEL, effort: "low", mode: "agent" } });
    chats.push(chat);
    const withSelection = await turn(chat, "Make the selected sentence much shorter.", { selection: { documentId: doc.id, text: sentence, from: 0, to: 0 } });
    assert.equal(withSelection.status, "done", withSelection.error ?? "");
    const text = docToMarkdown(doc.doc);
    assert.match(text, /^Keep this intro exactly\.\n\n/);
    assert.match(text, /\n\nKeep this outro exactly\.$/);
    assert.doesNotMatch(text, /In order to be able to/);
  });

  describe("external Claude Code over HTTP", () => {
    let server: Server;
    let url = "";

    before(async () => {
      const route = await import("@/app/api/mcp/route");
      server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const request = new Request(`http://localhost${req.url}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
        });
        const handler = route[req.method as "POST" | "GET" | "DELETE"];
        const response = handler ? await handler(request) : new Response(null, { status: 405 });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`;
    });

    after(() => new Promise<void>((resolve) => server.close(() => resolve())));

    test("`claude -p` with Inline's MCP server edits the open document", async () => {
      const doc = await hub.create({ title: "Shopping", markdown: "- Apples\n- Bread" });
      hub.activeDocumentId = doc.id;
      const config = path.join(dataDir, "mcp.json");
      writeFileSync(config, JSON.stringify({ mcpServers: { inline: { type: "http", url } } }));
      const { stdout } = await run(
        "claude",
        ["-p", "Add 'Milk' as a new item at the end of the list in my open Inline document. Use the Inline tools.", "--mcp-config", config, "--strict-mcp-config", "--allowedTools", "mcp__inline__*", "--model", MODEL, "--max-turns", "8"],
        { cwd: dataDir, timeout: 240_000, env: { ...process.env, CLAUDECODE: "" } },
      );
      assert.match(docToMarkdown(doc.doc), /- Apples\n- Bread\n- Milk/, stdout);
      assert.ok(doc.hunks.some((hunk) => hunk.author === "external"));
    });
  });
});

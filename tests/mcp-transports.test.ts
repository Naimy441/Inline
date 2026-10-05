import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { MCP_SERVER_NAME, mcpToolName } from "@/lib/agent/mcp";
import { TOOLS, type ToolContext } from "@/lib/agent/tools";
import { docToMarkdown } from "@/lib/doc/markdown";
import { documentHub } from "@/lib/server/hub";

import { MCP_URL, connectHttp, connectInProcess, routeFetch, useTempDataDir, type McpHarness } from "./support/mcp";

/**
 * The same tool registry is served two ways: in-process to the in-app
 * Claude Code session, and over Streamable HTTP at /api/mcp for external
 * MCP clients. Both are exercised here with the official MCP client.
 */

useTempDataDir("inline-mcp-");

const NOTE = "# Trip {.title}\n\nWe leave on Monday.\n\nPack light.";

describe("in-process server (in-app agent)", () => {
  let mcp: McpHarness;
  let context: ToolContext;
  let documentId: string;

  before(async () => {
    const doc = await documentHub().create({ title: "Trip", markdown: NOTE });
    documentId = doc.id;
    context = { author: "chat-1", documentId };
    mcp = await connectInProcess(() => context);
  });
  after(() => mcp.close());

  test("lists every tool with its schema and annotations", async () => {
    const { tools } = await mcp.client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOLS.map((tool) => tool.name).sort());
    for (const definition of TOOLS) {
      const listed = tools.find((tool) => tool.name === definition.name)!;
      assert.equal(listed.description, definition.description);
      assert.equal(listed.inputSchema.type, "object");
      assert.equal(listed.annotations?.readOnlyHint, !definition.write, definition.name);
      assert.equal(listed.annotations?.destructiveHint, Boolean(definition.destructive), definition.name);
      assert.equal(listed.annotations?.openWorldHint, false);
      for (const key of Object.keys(definition.shape)) assert.ok(key in (listed.inputSchema.properties ?? {}), `${definition.name}.${key}`);
    }
  });

  test("required arguments are marked required in the JSON schema", async () => {
    const { tools } = await mcp.client.listTools();
    const edit = tools.find((tool) => tool.name === "edit_document")!;
    assert.deepEqual([...(edit.inputSchema.required ?? [])].sort(), ["new_string", "old_string"]);
    const read = tools.find((tool) => tool.name === "read_document")!;
    assert.deepEqual(read.inputSchema.required ?? [], []);
  });

  test("tool calls run against the chat's document", async () => {
    const read = await mcp.call("read_document");
    assert.equal(read.isError, false);
    assert.match(read.text, /We leave on Monday\./);
    const edit = await mcp.call("edit_document", { old_string: "Monday", new_string: "Tuesday" });
    assert.equal(edit.isError, false, edit.text);
    const doc = await documentHub().require(documentId);
    assert.match(docToMarkdown(doc.doc), /Tuesday/);
    assert.equal(doc.hunks[0]!.author, "chat-1");
  });

  test("the context is read on every call, so mode switches apply to the next call", async () => {
    context = { ...context, readOnly: true };
    const refused = await mcp.call("edit_document", { old_string: "Pack light.", new_string: "Pack heavy." });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /Ask mode/);
    context = { ...context, readOnly: false };
    const allowed = await mcp.call("edit_document", { old_string: "Pack light.", new_string: "Pack heavy." });
    assert.equal(allowed.isError, false, allowed.text);
  });

  test("tool errors come back as isError results, not protocol errors", async () => {
    const result = await mcp.call("edit_document", { old_string: "nowhere to be found", new_string: "x" });
    assert.equal(result.isError, true);
    assert.match(result.text, /not found/);
  });

  test("schema violations are rejected", async () => {
    const result = await mcp.client.callTool({ name: "read_document", arguments: { limit: "lots" } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /limit/);
  });

  test("the namespaced names Claude Code sees", () => {
    assert.equal(MCP_SERVER_NAME, "inline");
    assert.equal(mcpToolName("edit_document"), "mcp__inline__edit_document");
    assert.equal(mcpToolName("*"), "mcp__inline__*");
  });
});

describe("HTTP server at /api/mcp (external clients)", () => {
  let mcp: McpHarness;
  let documentId: string;

  before(async () => {
    const doc = await documentHub().create({ title: "Trip (HTTP)", markdown: NOTE });
    documentId = doc.id;
    documentHub().activeDocumentId = documentId;
    mcp = await connectHttp();
  });
  after(() => mcp.close());

  test("initializes with Inline's identity and instructions", () => {
    const info = mcp.client.getServerVersion();
    assert.equal(info?.name, "inline");
    assert.equal(info?.title, "Inline");
    const instructions = mcp.client.getInstructions() ?? "";
    assert.match(instructions, /Inline is a document editor/);
    assert.match(instructions, /keep or undo each one/);
    assert.ok(mcp.client.getServerCapabilities()?.tools);
  });

  test("lists the same tools as the in-process server", async () => {
    const { tools } = await mcp.client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOLS.map((tool) => tool.name).sort());
    const write = tools.find((tool) => tool.name === "write_document")!;
    assert.equal(write.annotations?.destructiveHint, true);
    assert.equal(write.title, "Write document");
  });

  test("defaults to the document the user has open, and attributes edits to external", async () => {
    const read = await mcp.call("read_document");
    assert.match(read.text, new RegExp(`id ${documentId}`));
    const edit = await mcp.call("edit_document", { old_string: "Monday", new_string: "Friday" });
    assert.equal(edit.isError, false, edit.text);
    const doc = await documentHub().require(documentId);
    assert.match(docToMarkdown(doc.doc), /Friday/);
    assert.equal(doc.hunks.at(-1)!.author, "external");
  });

  test("changes made over HTTP reach live subscribers (the browser editor)", async () => {
    const doc = await documentHub().require(documentId);
    const events: string[] = [];
    const unsubscribe = doc.subscribe((event) => events.push(event.type));
    await mcp.call("insert_content", { content: "Bring a map.", position: "end" });
    unsubscribe();
    assert.ok(events.includes("steps"), events.join(","));
  });

  test("explicit document ids work across documents", async () => {
    const other = await documentHub().create({ title: "Other", markdown: "Second doc." });
    const read = await mcp.call("read_document", { document_id: other.id });
    assert.match(read.text, /Second doc\./);
    const list = await mcp.call("list_documents");
    assert.match(list.text, /"Other"/);
    assert.match(list.text, /"Trip \(HTTP\)"/);
  });

  test("each request is stateless: a second client sees the first client's edits", async () => {
    const second = await connectHttp();
    try {
      await mcp.call("edit_document", { old_string: "Pack light.", new_string: "Pack for rain." });
      const read = await second.call("read_document", { document_id: documentId });
      assert.match(read.text, /Pack for rain\./);
    } finally {
      await second.close();
    }
  });

  test("tool failures are isError results", async () => {
    const result = await mcp.call("restore_version", { version_id: "missing" });
    assert.equal(result.isError, true);
  });
});

describe("raw JSON-RPC over HTTP", () => {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

  async function rpc(body: unknown, extraHeaders: Record<string, string> = {}) {
    const fetchImpl = await routeFetch();
    return fetchImpl(MCP_URL, { method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });
  }

  test("initialize returns JSON, without a session id (stateless)", async () => {
    const response = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "1" } },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(response.headers.get("mcp-session-id"), null);
    const body = (await response.json()) as { result: { serverInfo: { name: string } } };
    assert.equal(body.result.serverInfo.name, "inline");
  });

  test("tools/call works without a prior initialize on the same server", async () => {
    await documentHub().create({ title: "Raw", markdown: "Raw text." }).then((doc) => (documentHub().activeDocumentId = doc.id));
    const response = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_document", arguments: {} } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
    assert.match(body.result.content[0]!.text, /Raw text\./);
  });

  test("malformed JSON is a JSON-RPC parse error", async () => {
    const fetchImpl = await routeFetch();
    const response = await fetchImpl(MCP_URL, { method: "POST", headers, body: "{not json" });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: number } };
    assert.equal(body.error.code, -32700);
  });

  test("a client that doesn't accept JSON and SSE is refused", async () => {
    const response = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { accept: "text/html" });
    assert.equal(response.status, 406);
  });

  test("unknown methods are JSON-RPC errors", async () => {
    const response = await rpc({ jsonrpc: "2.0", id: 4, method: "documents/delete_all" });
    const body = (await response.json()) as { error?: { code: number } };
    assert.equal(body.error?.code, -32601);
  });

  test("GET (server-initiated stream) is not offered by the stateless server", async () => {
    const fetchImpl = await routeFetch();
    const response = await fetchImpl(MCP_URL, { method: "GET", headers: { accept: "text/event-stream" } });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    const ended = await fetchImpl(MCP_URL, { method: "DELETE" });
    assert.equal(ended.status, 405);
  });
});

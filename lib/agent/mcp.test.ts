import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

// The store resolves its directory on each call, so this applies before any write.
process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-mcp-"));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Fragment, Slice } from "prosemirror-model";
import { ReplaceStep } from "prosemirror-transform";
import { POST as mcpRoute, GET as mcpGet } from "@/app/api/mcp/route";
import { createInlineHttpServer, createInlineSdkServer, MCP_SERVER_NAME } from "@/lib/agent/mcp";
import { DOCUMENT_FORMAT_GUIDE } from "@/lib/agent/prompt";
import { TOOLS, type ToolContext } from "@/lib/agent/tools";
import { docToMarkdown } from "@/lib/doc/markdown";
import { schema } from "@/lib/doc/schema";
import { documentHub } from "@/lib/server/hub";

/**
 * Inline's MCP server as an MCP client sees it: the protocol handshake, the
 * tool catalog, and multi-step agent work over the wire, including clients
 * racing each other and a user typing while Claude edits.
 */

type CallResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

async function connect(server: McpServer) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallResult;
    return { text: result.content.map((block) => block.text ?? "").join("\n"), isError: Boolean(result.isError) };
  };
  return { client, call };
}

const external = () => connect(createInlineHttpServer({ author: "external" }));

async function newDocument(markdown: string, title = "Notes") {
  return documentHub().create({ title, markdown });
}

function textPosition(node: import("prosemirror-model").Node, text: string) {
  let found = -1;
  node.descendants((child, pos) => {
    if (found < 0 && child.isText && child.text!.includes(text)) found = pos + child.text!.indexOf(text);
    return found < 0;
  });
  return found;
}

async function rpc(body: unknown, method = "POST") {
  const request = new Request("http://localhost:3000/api/mcp", {
    method,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  return method === "POST" ? mcpRoute(request) : mcpGet();
}

describe("protocol", () => {
  it("introduces itself with instructions on how documents work", async () => {
    const { client } = await external();
    assert.equal(client.getServerVersion()?.name, MCP_SERVER_NAME);
    assert.equal(client.getServerVersion()?.title, "Inline");
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /document editor/);
    assert.ok(instructions.includes(DOCUMENT_FORMAT_GUIDE));
    assert.ok(client.getServerCapabilities()?.tools);
  });

  it("lists every tool with a schema, a description and honest hints", async () => {
    const { client } = await external();
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      TOOLS.map((tool) => tool.name).sort(),
    );
    for (const tool of tools) {
      const definition = TOOLS.find((item) => item.name === tool.name)!;
      assert.equal(tool.inputSchema.type, "object", tool.name);
      assert.ok((tool.description ?? "").length > 40, `${tool.name} explains itself`);
      assert.equal(tool.annotations?.readOnlyHint, !definition.write, `${tool.name} readOnlyHint`);
      assert.equal(tool.annotations?.openWorldHint, false);
      for (const key of Object.keys(definition.shape)) assert.ok(key in (tool.inputSchema.properties ?? {}), `${tool.name}.${key} is in the schema`);
    }
    const edit = tools.find((tool) => tool.name === "edit_document")!;
    assert.deepEqual([...(edit.inputSchema.required ?? [])].sort(), ["new_string", "old_string"]);
    assert.equal(tools.find((tool) => tool.name === "write_document")!.annotations?.destructiveHint, true);
    assert.equal(tools.find((tool) => tool.name === "read_document")!.annotations?.destructiveHint, false);
  });

  it("serves the same catalog to the in-app agent", async () => {
    const config = createInlineSdkServer(() => ({ author: "chat" }));
    const { client } = await connect(config.instance as McpServer);
    const inApp = (await client.listTools()).tools;
    const http = (await (await external()).client.listTools()).tools;
    assert.deepEqual(
      inApp.map((tool) => [tool.name, tool.annotations?.readOnlyHint]).sort(),
      http.map((tool) => [tool.name, tool.annotations?.readOnlyHint]).sort(),
    );
  });

  it("returns bad arguments and unknown tools as errors, not crashes", async () => {
    const doc = await newDocument("Some text.");
    const { client, call } = await external();
    const bad = await call("edit_document", { document_id: doc.id, old_string: 4, new_string: "x" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /old_string/);
    const unknown = await client.callTool({ name: "delete_everything", arguments: {} }).then(
      (result) => (result as CallResult).isError === true,
      () => true,
    );
    assert.ok(unknown);
    const missingDoc = await call("read_document", { document_id: "doesnotexist" });
    assert.equal(missingDoc.isError, true);
    assert.equal(docToMarkdown(doc.doc).trim(), "Some text.");
  });
});

describe("the HTTP endpoint", () => {
  it("answers a stateless handshake and tool calls as JSON", async () => {
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "1" } } });
    assert.equal(init.status, 200);
    assert.match(init.headers.get("content-type") ?? "", /application\/json/);
    const hello = (await init.json()) as { result: { serverInfo: { name: string } } };
    assert.equal(hello.result.serverInfo.name, "inline");

    const doc = await newDocument("Over the wire.");
    const read = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_document", arguments: { document_id: doc.id } } });
    const body = (await read.json()) as { result: CallResult };
    assert.match(body.result.content[0]!.text!, /1\tOver the wire\./);
  });

  it("rejects malformed requests", async () => {
    const response = await rpc("{not json");
    assert.ok(response.status >= 400 && response.status < 500);
    const message = (await response.json()) as { error?: { code: number } };
    assert.equal(message.error?.code, -32700);
  });

  it("refuses a server-sent event stream it can't provide", async () => {
    const response = await rpc(null, "GET");
    assert.equal(response.status, 405);
  });
});

describe("agent work over MCP", () => {
  it("drafts, structures, reviews and versions a document end to end", async () => {
    const { call } = await external();

    const created = await call("create_document", { title: "Launch plan", content: "# Launch plan {.title}\n\nWe ship in May." });
    assert.equal(created.isError, false, created.text);
    const id = (await documentHub().list()).find((meta) => meta.title === "Launch plan")!.id;
    assert.match((await call("list_documents")).text, /Launch plan/);

    const written = await call("insert_content", { document_id: id, position: "end", content: "## Risks\n\n- Hiring is slow\n- Vendors are late\n\n## Owners\n\nDana owns marketing." });
    assert.equal(written.isError, false, written.text);
    const outline = await call("get_outline", { document_id: id });
    assert.match(outline.text, /Risks[\s\S]*Owners/);

    assert.equal((await call("format_text", { document_id: id, text: "We ship in May.", bold: true })).isError, false);
    assert.equal((await call("add_comment", { document_id: id, text: "Vendors are late", comment: "Which vendors?" })).isError, false);
    assert.match((await call("list_comments", { document_id: id })).text, /Which vendors\?/);

    const saved = await call("save_version", { document_id: id, label: "Before cuts" });
    assert.equal(saved.isError, false, saved.text);
    const edit = await call("multi_edit_document", {
      document_id: id,
      edits: [
        { old_string: "We ship in May.", new_string: "We ship in June." },
        { old_string: "- Hiring is slow\n", new_string: "" },
      ],
    });
    assert.equal(edit.isError, false, edit.text);

    const pending = await call("get_pending_changes", { document_id: id });
    assert.match(pending.text, /June/);
    const doc = (await documentHub().get(id))!;
    assert.ok(doc.hunks.length >= 2);
    assert.ok(doc.hunks.every((hunk) => hunk.author === "external"), "outside clients' edits are attributed to them");

    const search = await call("search_document", { document_id: id, pattern: "June|Hiring", regex: true });
    assert.match(search.text, /June/);
    assert.doesNotMatch(search.text, /Hiring/);

    const versions = await call("list_versions", { document_id: id });
    const versionId = versions.text.match(/^- (\S+): "Before cuts"/m)?.[1];
    assert.ok(versionId, versions.text);
    assert.equal((await call("restore_version", { document_id: id, version_id: versionId })).isError, false);
    const read = await call("read_document", { document_id: id });
    assert.match(read.text, /We ship in May/);
    assert.match(read.text, /Hiring is slow/);
  });

  it("sees what the user kept and undid", async () => {
    const doc = await newDocument("Alpha beta gamma.\n\nDelta epsilon.");
    const { call } = await external();
    await call("edit_document", { document_id: doc.id, old_string: "beta", new_string: "BETA" });
    await call("edit_document", { document_id: doc.id, old_string: "epsilon", new_string: "EPSILON" });
    const [first, second] = doc.hunks;
    doc.review("accept", [first!.id]);
    doc.review("reject", [second!.id]);
    const pending = await call("get_pending_changes", { document_id: doc.id });
    assert.match(pending.text, /no pending/i);
    const read = await call("read_document", { document_id: doc.id });
    assert.match(read.text, /Alpha BETA gamma/);
    assert.match(read.text, /Delta epsilon/);
  });

  it("can revert its own work when asked", async () => {
    const doc = await newDocument("Keep this sentence exactly.");
    const { call } = await external();
    await call("write_document", { document_id: doc.id, content: "Something else entirely." });
    assert.equal(docToMarkdown(doc.doc).trim(), "Something else entirely.");
    const reverted = await call("revert_changes", { document_id: doc.id, all: true });
    assert.equal(reverted.isError, false, reverted.text);
    assert.equal(docToMarkdown(doc.doc).trim(), "Keep this sentence exactly.");
    assert.equal(doc.hunks.length, 0);
  });

  it("keeps the user's typing when Claude edits right after", async () => {
    const doc = await newDocument("The draft opens slowly.\n\nIt closes well.");
    const { call } = await external();
    const before = await call("read_document", { document_id: doc.id });
    assert.match(before.text, /opens slowly/);

    // The user types between Claude reading and Claude editing.
    const at = textPosition(doc.doc, "It closes");
    doc.receiveClientSteps(doc.version, [new ReplaceStep(at, at, new Slice(Fragment.from(schema.text("Finally, ")), 0, 0)).toJSON()], "browser");

    const edited = await call("edit_document", { document_id: doc.id, old_string: "opens slowly", new_string: "opens with a hook" });
    assert.equal(edited.isError, false, edited.text);
    assert.equal(docToMarkdown(doc.doc).trim(), "The draft opens with a hook.\n\nFinally, It closes well.");
    assert.equal(doc.hunks.length, 1, "only Claude's edit is up for review");
  });

  it("fails cleanly when the text Claude read was changed by the user", async () => {
    const doc = await newDocument("Original phrasing here.");
    const { call } = await external();
    const at = textPosition(doc.doc, "phrasing");
    doc.receiveClientSteps(doc.version, [new ReplaceStep(at, at + 8, new Slice(Fragment.from(schema.text("wording")), 0, 0)).toJSON()], "browser");
    const edit = await call("edit_document", { document_id: doc.id, old_string: "Original phrasing", new_string: "New phrasing" });
    assert.equal(edit.isError, true);
    assert.match(edit.text, /not found/i);
    assert.equal(docToMarkdown(doc.doc).trim(), "Original wording here.");
  });

  it("applies simultaneous edits from two clients without losing either", async () => {
    const doc = await newDocument("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.");
    const [one, two] = [await external(), await external()];
    const results = await Promise.all([
      one.call("edit_document", { document_id: doc.id, old_string: "First paragraph.", new_string: "First, rewritten." }),
      two.call("edit_document", { document_id: doc.id, old_string: "Third paragraph.", new_string: "Third, rewritten." }),
      one.call("insert_content", { document_id: doc.id, position: "end", content: "Fourth paragraph." }),
    ]);
    assert.ok(results.every((result) => !result.isError), results.map((result) => result.text).join("\n"));
    assert.equal(docToMarkdown(doc.doc).trim(), "First, rewritten.\n\nSecond paragraph.\n\nThird, rewritten.\n\nFourth paragraph.");
  });

  it("lets only one of two conflicting edits win", async () => {
    const doc = await newDocument("Contested sentence.");
    const [one, two] = [await external(), await external()];
    const results = await Promise.all([
      one.call("edit_document", { document_id: doc.id, old_string: "Contested sentence.", new_string: "Version A." }),
      two.call("edit_document", { document_id: doc.id, old_string: "Contested sentence.", new_string: "Version B." }),
    ]);
    assert.deepEqual(results.map((result) => result.isError).sort(), [false, true]);
    assert.match(docToMarkdown(doc.doc).trim(), /^Version [AB]\.$/);
  });

  it("works through a long document in pages", async () => {
    const lines = Array.from({ length: 1500 }, (_, index) => `Paragraph ${index + 1} of the long report.`);
    const doc = await newDocument(lines.join("\n\n"), "Long report");
    const { call } = await external();

    const page = await call("read_document", { document_id: doc.id, offset: 2001, limit: 5 });
    assert.match(page.text, /2001\tParagraph 1001 of the long report\./);
    assert.doesNotMatch(page.text, /Paragraph 1004 /);

    const found = await call("search_document", { document_id: doc.id, pattern: "Paragraph 1499 " });
    assert.match(found.text, /2997/);

    const started = performance.now();
    const edit = await call("edit_document", { document_id: doc.id, old_string: "Paragraph 1499 of", new_string: "Paragraph 1499 (revised) of" });
    assert.equal(edit.isError, false, edit.text);
    assert.ok(performance.now() - started < 2000, "an edit in a long document stays fast");
    assert.match(docToMarkdown(doc.doc), /Paragraph 1499 \(revised\) of/);
  });

  it("reads the open editor's selection for the in-app agent", async () => {
    const doc = await newDocument("Pick these words out.");
    const context: ToolContext = { author: "chat", documentId: doc.id };
    const { call } = await connect(createInlineSdkServer(() => context).instance as McpServer);
    const from = textPosition(doc.doc, "these words");
    doc.setSelection({ from, to: from + "these words".length, version: doc.version });
    const editor = await call("get_editor_context");
    assert.match(editor.text, /these words/);
    const edited = await call("edit_document", { old_string: "these words", new_string: "those words" });
    assert.equal(edited.isError, false, edited.text);
    assert.equal(doc.hunks[0]!.author, "chat");
  });
});

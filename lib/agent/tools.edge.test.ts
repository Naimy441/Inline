import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Transform } from "prosemirror-transform";

import { READ_ONLY_TOOL_NAMES, runTool, TOOLS, WRITE_TOOL_NAMES } from "@/lib/agent/tools";
import { docToMarkdown } from "@/lib/doc/markdown";
import { schema } from "@/lib/doc/schema";
import { documentHub, type HubEvent } from "@/lib/server/hub";

process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-tools-edge-"));

const SAMPLE = `# Field notes {.title}

The quick brown fox jumps over the lazy dog.

## Findings

- Foxes are quick
- Dogs are lazy`;

async function setup(ctx: { readOnly?: boolean } = {}) {
  const doc = await documentHub().create({ title: "Field notes", markdown: SAMPLE });
  return { doc, ctx: { author: "chat-edge", documentId: doc.id, ...ctx } };
}

function textRange(node: import("prosemirror-model").Node, text: string) {
  let from = -1;
  node.descendants((child, pos) => {
    if (from < 0 && child.isText && child.text!.includes(text)) from = pos + child.text!.indexOf(text);
    return from < 0;
  });
  assert.ok(from >= 0);
  return { from, to: from + text.length };
}

describe("tool catalog", () => {
  it("every tool has a unique name, a description and a read/write class", () => {
    const names = TOOLS.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length);
    for (const tool of TOOLS) {
      assert.match(tool.name, /^[a-z_]+$/);
      assert.ok(tool.description.length > 20, `${tool.name} is described`);
    }
    assert.equal(READ_ONLY_TOOL_NAMES.length + WRITE_TOOL_NAMES.length, TOOLS.length);
    for (const name of ["edit_document", "write_document", "keep_changes", "revert_changes"]) assert.ok(WRITE_TOOL_NAMES.includes(name), name);
    for (const name of ["read_document", "get_pending_changes", "list_comments"]) assert.ok(READ_ONLY_TOOL_NAMES.includes(name), name);
  });

  it("unknown tools fail cleanly", async () => {
    const { ctx } = await setup();
    const result = await runTool("delete_everything", {}, ctx);
    assert.equal(result.isError, true);
    assert.match(result.text, /Unknown tool/);
  });
});

describe("reading", () => {
  it("read_document pages through lines with offset and limit", async () => {
    const { ctx } = await setup();
    const result = await runTool("read_document", { offset: 5, limit: 1 }, ctx);
    assert.match(result.text, /\s+5\t## Findings/);
    assert.doesNotMatch(result.text, /quick brown fox/);
  });

  it("search_document supports regular expressions and reports no matches", async () => {
    const { ctx } = await setup();
    const regex = await runTool("search_document", { pattern: "Fox(es)?", regex: true }, ctx);
    assert.match(regex.text, /Foxes are quick/);
    const none = await runTool("search_document", { pattern: "zebra" }, ctx);
    assert.doesNotMatch(none.text, /zebra.*\t/);
    assert.match(none.text, /No lines match "zebra"/);
  });

  it("get_editor_context describes the user's selection", async () => {
    const { doc, ctx } = await setup();
    const { from, to } = textRange(doc.doc, "lazy dog");
    doc.setSelection({ from, to, version: doc.version });
    const result = await runTool("get_editor_context", {}, ctx);
    assert.match(result.text, /lazy dog/);
    assert.match(result.text, /No pending changes/);
  });
});

describe("editing", () => {
  it("multi_edit_document is all or nothing", async () => {
    const { doc, ctx } = await setup();
    const before = docToMarkdown(doc.doc);
    const result = await runTool("multi_edit_document", { edits: [{ old_string: "quick brown", new_string: "slow red" }, { old_string: "no such text", new_string: "x" }] }, ctx);
    assert.equal(result.isError, true);
    assert.equal(docToMarkdown(doc.doc), before);
    const ok = await runTool("multi_edit_document", { edits: [{ old_string: "quick brown", new_string: "slow red" }, { old_string: "lazy dog.", new_string: "sleepy cat." }] }, ctx);
    assert.equal(ok.isError, undefined, ok.text);
    assert.match(docToMarkdown(doc.doc), /slow red fox jumps over the sleepy cat\./);
  });

  it("replace_all changes every occurrence", async () => {
    const { doc, ctx } = await setup();
    const result = await runTool("edit_document", { old_string: "are", new_string: "seem", replace_all: true }, ctx);
    assert.equal(result.isError, undefined, result.text);
    assert.equal((docToMarkdown(doc.doc).match(/seem/g) ?? []).length, 2);
  });

  it("write_document replaces the whole document and is reviewable", async () => {
    const { doc, ctx } = await setup();
    const result = await runTool("write_document", { content: "# New {.title}\n\nOnly this." }, ctx);
    assert.equal(result.isError, undefined, result.text);
    assert.equal(doc.doc.textContent, "NewOnly this.");
    assert.ok(doc.hunks.length > 0);
    await runTool("revert_changes", { all: true }, ctx);
    assert.match(docToMarkdown(doc.doc), /quick brown fox/);
  });

  it("insert_content can add at the start and before a line", async () => {
    const { doc, ctx } = await setup();
    await runTool("insert_content", { content: "Preface.", position: "start" }, ctx);
    assert.ok(docToMarkdown(doc.doc).startsWith("Preface."));
    const before = await runTool("insert_content", { content: "Context first.", position: "before_line", line: 7 }, ctx);
    assert.equal(before.isError, undefined, before.text);
    assert.match(docToMarkdown(doc.doc), /Context first\.\n\n## Findings/);
    const missing = await runTool("insert_content", { content: "x", position: "after_line" }, ctx);
    assert.equal(missing.isError, true, "after_line needs a line");
  });

  it("set_paragraph_style turns a paragraph into a heading and aligns it", async () => {
    const { doc, ctx } = await setup();
    const result = await runTool("set_paragraph_style", { from_line: 3, type: "heading", level: 3, align: "center" }, ctx);
    assert.equal(result.isError, undefined, result.text);
    assert.match(docToMarkdown(doc.doc), /### The quick brown fox jumps over the lazy dog\. \{align=center\}/);
  });

  it("format_text reports missing and ambiguous text", async () => {
    const { ctx } = await setup();
    const missing = await runTool("format_text", { text: "purple", italic: true }, ctx);
    assert.equal(missing.isError, true);
    const all = await runTool("format_text", { text: "are", all: true, italic: true }, ctx);
    assert.equal(all.isError, undefined, all.text);
  });

  it("refuses to change text the user locked", async () => {
    const { doc, ctx } = await setup();
    const { from, to } = textRange(doc.doc, "lazy dog");
    doc.applyTransform(new Transform(doc.doc).addMark(from, to, schema.mark("locked", { id: "lock1" })), { kind: "system", label: "lock" });
    const result = await runTool("edit_document", { old_string: "lazy dog", new_string: "cat" }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.text, /lock/i);
  });

  it("Ask mode refuses keep, revert, create and restore", async () => {
    const { ctx } = await setup({ readOnly: true });
    for (const [name, args] of [
      ["keep_changes", { all: true }],
      ["revert_changes", { all: true }],
      ["create_document", { title: "x" }],
      ["restore_version", { version_id: "v" }],
    ] as const) {
      const result = await runTool(name, args, ctx);
      assert.equal(result.isError, true, name);
      assert.match(result.text, /Ask mode/, name);
    }
  });
});

describe("review tools", () => {
  it("revert_changes undoes only the listed change", async () => {
    const { doc, ctx } = await setup();
    await runTool("edit_document", { old_string: "quick brown", new_string: "slow red" }, ctx);
    await runTool("edit_document", { old_string: "Dogs are lazy", new_string: "Dogs nap" }, ctx);
    assert.equal(doc.hunks.length, 2);
    const first = doc.hunksJSON().find((hunk) => hunk.deletedText.includes("quick"))!;
    const result = await runTool("revert_changes", { change_ids: [first.id] }, ctx);
    assert.equal(result.isError, undefined, result.text);
    const markdown = docToMarkdown(doc.doc);
    assert.match(markdown, /quick brown/);
    assert.match(markdown, /Dogs nap/);
    assert.equal(doc.hunks.length, 1);
  });

  it("keep_changes and revert_changes need ids or all", async () => {
    const { ctx } = await setup();
    assert.equal((await runTool("keep_changes", {}, ctx)).isError, true);
    assert.equal((await runTool("revert_changes", { change_ids: ["nope"] }, ctx)).isError, true);
  });
});

describe("comments", () => {
  it("reply_to_comment can resolve, and resolve_comment can reopen", async () => {
    const { doc, ctx } = await setup();
    await runTool("add_comment", { text: "lazy dog", comment: "Unkind?" }, ctx);
    const [comment] = doc.comments;
    const reply = await runTool("reply_to_comment", { comment_id: comment!.id, reply: "Softened it.", resolve: true }, ctx);
    assert.equal(reply.isError, undefined, reply.text);
    assert.equal(doc.comments[0]!.resolved, true);
    assert.equal(doc.comments[0]!.replies[0]!.author, "claude");
    const open = await runTool("list_comments", {}, ctx);
    assert.match(open.text, /No open comments/);
    await runTool("resolve_comment", { comment_id: comment!.id, resolved: false }, ctx);
    assert.equal(doc.comments[0]!.resolved, false);
  });

  it("add_comment asks for an occurrence when the text repeats", async () => {
    const { ctx } = await setup();
    const result = await runTool("add_comment", { text: "are", comment: "?" }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.text, /occurrence/);
    const second = await runTool("add_comment", { text: "are", occurrence: 2, comment: "?" }, ctx);
    assert.equal(second.isError, undefined, second.text);
  });
});

describe("documents and the editor", () => {
  it("open_document and export_document command the open editor", async () => {
    const { doc, ctx } = await setup();
    const other = await documentHub().create({ title: "Other" });
    const events: HubEvent[] = [];
    doc.subscribe((event) => events.push(event));
    const opened = await runTool("open_document", { document_id: other.id }, ctx);
    assert.match(opened.text, /Opened "Other"/);
    const pdf = await runTool("export_document", { format: "pdf" }, ctx);
    assert.equal(pdf.isError, undefined, pdf.text);
    const docx = await runTool("export_document", { format: "docx" }, ctx);
    assert.match(docx.text, /\/api\/documents\/.+\/export\?format=docx/);
    const kinds = events.flatMap((event) => (event.type === "command" ? [event.command.kind] : []));
    assert.deepEqual(kinds, ["open_document", "export_pdf", "download"]);
  });

  it("PDF export needs the document open in an editor", async () => {
    const { ctx } = await setup();
    const result = await runTool("export_document", { format: "pdf" }, ctx);
    assert.equal(result.isError, true);
  });

  it("tools default to the chat's document and accept another by id", async () => {
    const { ctx } = await setup();
    const other = await documentHub().create({ title: "Elsewhere", markdown: "Different body" });
    const result = await runTool("read_document", { document_id: other.id }, ctx);
    assert.match(result.text, /Different body/);
    const missing = await runTool("read_document", { document_id: "doesnotexist" }, ctx);
    assert.equal(missing.isError, true);
  });

  it("update_document_settings maps font names, sanitizes others and rejects out-of-range values", async () => {
    const { doc, ctx } = await setup();
    await runTool("update_document_settings", { font_family: "georgia" }, ctx);
    assert.equal(doc.meta.settings.fontFamily, "Georgia, serif");
    await runTool("update_document_settings", { font_family: "Lato; color: red" }, ctx);
    assert.equal(doc.meta.settings.fontFamily, '"Lato color red", sans-serif');
    const font = await runTool("update_document_settings", { font_family: ";;;" }, ctx);
    assert.equal(font.isError, true);
    const size = await runTool("update_document_settings", { font_size: 400 }, ctx);
    assert.equal(size.isError, true);
    const paper = await runTool("update_document_settings", { paper_size: "a4", orientation: "landscape" }, ctx);
    assert.equal(paper.isError, undefined, paper.text);
  });
});

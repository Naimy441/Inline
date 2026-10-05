import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import { ReplaceStep } from "prosemirror-transform";

import { runTool } from "@/lib/agent/tools";
import { schema } from "@/lib/doc/schema";
import { docToMarkdown } from "@/lib/doc/markdown";
import { documentHub } from "@/lib/server/hub";

// The store resolves its directory on each call, so this applies before any write.
process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-tools-"));

const SAMPLE = `# Field notes {.title}

The quick brown fox jumps over the lazy dog.

## Findings

- Foxes are quick
- Dogs are lazy`;

async function setup(ctx: { readOnly?: boolean } = {}) {
  const doc = await documentHub().create({ title: "Field notes", markdown: SAMPLE });
  return { doc, ctx: { author: "chat-test", documentId: doc.id, ...ctx } };
}

test("read_document returns numbered Markdown with a header", async () => {
  const { ctx } = await setup();
  const result = await runTool("read_document", {}, ctx);
  assert.equal(result.isError, undefined);
  assert.match(result.text, /Document "Field notes"/);
  assert.match(result.text, /\s+1\t# Field notes \{\.title\}/);
  assert.match(result.text, /\s+5\t## Findings/);
});

test("edit_document changes text, records a review hunk and returns edited lines", async () => {
  const { doc, ctx } = await setup();
  const result = await runTool("edit_document", { old_string: "lazy dog", new_string: "sleepy dog" }, ctx);
  assert.equal(result.isError, undefined, result.text);
  assert.match(result.text, /sleepy dog/);
  assert.match(docToMarkdown(doc.doc), /sleepy dog/);
  assert.equal(doc.hunks.length, 1);

  const pending = await runTool("get_pending_changes", {}, ctx);
  assert.match(pending.text, /lazy/);
  const reverted = await runTool("revert_changes", { all: true }, ctx);
  assert.equal(reverted.isError, undefined, reverted.text);
  assert.match(docToMarkdown(doc.doc), /lazy dog\./);
  assert.equal(doc.hunks.length, 0);
});

test("edit errors read like Claude Code's", async () => {
  const { ctx } = await setup();
  const missing = await runTool("edit_document", { old_string: "purple cat", new_string: "x" }, ctx);
  assert.equal(missing.isError, true);
  assert.match(missing.text, /not found/i);
  const ambiguous = await runTool("edit_document", { old_string: "are", new_string: "were" }, ctx);
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /Found 2 matches/);
});

test("Ask mode refuses write tools", async () => {
  const { doc, ctx } = await setup({ readOnly: true });
  const result = await runTool("write_document", { content: "Gone" }, ctx);
  assert.equal(result.isError, true);
  assert.match(result.text, /Ask mode/);
  assert.match(docToMarkdown(doc.doc), /quick brown fox/);
});

test("argument validation reports the bad field", async () => {
  const { ctx } = await setup();
  const result = await runTool("edit_document", { old_string: 4 }, ctx);
  assert.equal(result.isError, true);
  assert.match(result.text, /old_string/);
});

test("insert, format, outline, search and comments work together", async () => {
  const { doc, ctx } = await setup();
  const inserted = await runTool("insert_content", { content: "- Birds are loud", position: "after_line", line: 8 }, ctx);
  assert.equal(inserted.isError, undefined, inserted.text);
  assert.match(docToMarkdown(doc.doc), /- Dogs are lazy\n- Birds are loud/);

  const formatted = await runTool("format_text", { text: "quick brown fox", bold: true, color: "#c5221f" }, ctx);
  assert.equal(formatted.isError, undefined, formatted.text);
  assert.match(docToMarkdown(doc.doc), /\*\*quick brown fox\*\*/);

  const outline = await runTool("get_outline", {}, ctx);
  assert.match(outline.text, /Findings/);

  const search = await runTool("search_document", { pattern: "lazy" }, ctx);
  assert.match(search.text, /lazy/);

  const comment = await runTool("add_comment", { text: "jumps over", comment: "Is this accurate?" }, ctx);
  assert.equal(comment.isError, undefined, comment.text);
  const comments = await runTool("list_comments", {}, ctx);
  assert.match(comments.text, /Is this accurate\?/);
});

test("documents and versions", async () => {
  const { ctx } = await setup();
  const created = await runTool("create_document", { title: "Plan", content: "# Plan {.title}\n\nStep one." }, ctx);
  assert.equal(created.isError, undefined, created.text);
  const listed = await runTool("list_documents", {}, ctx);
  assert.match(listed.text, /Plan/);

  const saved = await runTool("save_version", { label: "Draft 1" }, ctx);
  assert.equal(saved.isError, undefined, saved.text);
  await runTool("edit_document", { old_string: "quick brown", new_string: "slow red" }, ctx);
  const versions = await runTool("list_versions", {}, ctx);
  const id = versions.text.match(/^- (\S+): "Draft 1"/m)?.[1];
  assert.ok(id, versions.text);
  const restored = await runTool("restore_version", { version_id: id }, ctx);
  assert.equal(restored.isError, undefined, restored.text);
  const read = await runTool("read_document", {}, ctx);
  assert.match(read.text, /quick brown/);
});

test("analyze_writing and settings", async () => {
  const { ctx } = await setup();
  const analysis = await runTool("analyze_writing", {}, ctx);
  assert.equal(analysis.isError, undefined, analysis.text);
  assert.match(analysis.text, /words/i);
  const updated = await runTool("update_document_settings", { font_family: "Georgia", line_spacing: 2 }, ctx);
  assert.equal(updated.isError, undefined, updated.text);
  const settings = await runTool("get_document_settings", {}, ctx);
  assert.match(settings.text, /Georgia/);
});

test("edits made in suggesting mode become the user's pending suggestions", async () => {
  const { doc, ctx } = await setup();
  const pos = findText(doc.doc, "lazy dog");
  assert.ok(pos > 0);
  const step = new ReplaceStep(pos, pos + 4, new Slice(Fragment.from(schema.text("sleepy")), 0, 0));
  doc.receiveClientSteps(doc.version, [step.toJSON()], "client-1", { suggest: true });
  assert.equal(doc.hunks.length, 1);
  assert.equal(doc.hunks[0]!.author, "user");

  const pending = await runTool("get_pending_changes", {}, ctx);
  assert.match(pending.text, /suggested by the user/);
  const kept = await runTool("keep_changes", { all: true }, ctx);
  assert.equal(kept.isError, undefined, kept.text);
  assert.equal(doc.hunks.length, 0);
  assert.match(docToMarkdown(doc.doc), /sleepy dog/);

  // Plain edits are not tracked.
  doc.receiveClientSteps(doc.version, [new ReplaceStep(pos, pos + 6, new Slice(Fragment.from(schema.text("lazy")), 0, 0)).toJSON()], "client-1");
  assert.equal(doc.hunks.length, 0);
});

function findText(node: PMNode, text: string) {
  let found = -1;
  node.descendants((child, pos) => {
    if (found >= 0) return false;
    if (child.isText && child.text!.includes(text)) found = pos + child.text!.indexOf(text);
    return true;
  });
  return found;
}

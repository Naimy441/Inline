import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import { ReplaceStep, Transform } from "prosemirror-transform";

import { READ_ONLY_TOOL_NAMES, TOOLS, WRITE_TOOL_NAMES, runTool, type ToolContext } from "@/lib/agent/tools";
import { schema } from "@/lib/doc/schema";
import { docToMarkdown } from "@/lib/doc/markdown";
import { documentHub, type HubEvent, type LiveDocument } from "@/lib/server/hub";

// The store resolves its directory on each call, so this applies before any write.
process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-tools-"));

const SAMPLE = `# Field notes {.title}

The quick brown fox jumps over the lazy dog.

## Findings

- Foxes are quick
- Dogs are lazy`;

async function setup(ctx: Partial<ToolContext> = {}, markdown = SAMPLE) {
  const doc = await documentHub().create({ title: "Field notes", markdown });
  return { doc, ctx: { author: "chat-test", documentId: doc.id, ...ctx } as ToolContext };
}

function md(doc: LiveDocument) {
  return docToMarkdown(doc.doc);
}

function findText(node: PMNode, text: string) {
  let found = -1;
  node.descendants((child, pos) => {
    if (found >= 0) return false;
    if (child.isText && child.text!.includes(text)) found = pos + child.text!.indexOf(text);
    return true;
  });
  return found;
}

/** Lock a passage from AI edits, the way the editor's lock command does. */
function lock(doc: LiveDocument, text: string) {
  const from = findText(doc.doc, text);
  assert.ok(from >= 0, `"${text}" not in document`);
  const tr = new Transform(doc.doc).addMark(from, from + text.length, schema.mark("locked", { id: "lock-1" }));
  doc.applyTransform(tr, { kind: "system", label: "lock" });
}

/** Minimal valid arguments for every tool, used by the cross-cutting tests. */
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  read_document: {},
  edit_document: { old_string: "lazy dog", new_string: "sleepy dog" },
  multi_edit_document: { edits: [{ old_string: "lazy dog", new_string: "sleepy dog" }] },
  write_document: { content: "Replaced." },
  insert_content: { content: "New paragraph.", position: "end" },
  search_document: { pattern: "fox" },
  get_outline: {},
  format_text: { text: "quick brown fox", bold: true },
  set_paragraph_style: { from_line: 3, align: "center" },
  get_document_settings: {},
  update_document_settings: { font_size: 12 },
  get_editor_context: {},
  get_pending_changes: {},
  revert_changes: { all: true },
  keep_changes: { all: true },
  list_comments: {},
  add_comment: { text: "jumps over", comment: "Source?" },
  reply_to_comment: { comment_id: "missing", reply: "Done." },
  resolve_comment: { comment_id: "missing" },
  analyze_writing: {},
  count_words: {},
  get_page_count: {},
  list_documents: {},
  create_document: { title: "Another" },
  open_document: { document_id: "missing" },
  save_version: { label: "Snapshot" },
  list_versions: {},
  restore_version: { version_id: "missing" },
  export_document: { format: "md" },
  delete_comment: { comment_id: "missing" },
  lock_text: { text: "quick brown fox" },
  list_locked_text: {},
  insert_image: { url: "https://example.com/a.png", position: "end" },
  read_attachment: { attachment_id: "missing" },
};

describe("tool registry", () => {
  test("every tool has a unique snake_case name, a title, a description and a JSON-schema-able shape", () => {
    const names = TOOLS.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length, "duplicate tool names");
    for (const tool of TOOLS) {
      assert.match(tool.name, /^[a-z][a-z_]*$/);
      assert.ok(tool.title.length > 0, tool.name);
      assert.ok(tool.description.length >= 20, `${tool.name} description is too short`);
      assert.equal(typeof tool.handler, "function");
    }
  });

  test("read-only and write tool lists partition the registry", () => {
    assert.deepEqual([...READ_ONLY_TOOL_NAMES, ...WRITE_TOOL_NAMES].sort(), TOOLS.map((tool) => tool.name).sort());
    for (const name of ["read_document", "search_document", "get_outline", "get_pending_changes", "list_comments", "list_documents", "analyze_writing"]) {
      assert.ok(READ_ONLY_TOOL_NAMES.includes(name), name);
    }
    for (const name of ["edit_document", "write_document", "format_text", "add_comment", "keep_changes", "restore_version", "save_version"]) {
      assert.ok(WRITE_TOOL_NAMES.includes(name), name);
    }
  });

  test("the cross-cutting fixtures cover every tool", () => {
    assert.deepEqual(Object.keys(MINIMAL_ARGS).sort(), TOOLS.map((tool) => tool.name).sort());
  });

  test("unknown tools fail cleanly", async () => {
    const result = await runTool("delete_everything", {}, { author: "t" });
    assert.equal(result.isError, true);
    assert.match(result.text, /Unknown tool delete_everything/);
  });
});

describe("Ask mode", () => {
  for (const name of WRITE_TOOL_NAMES) {
    test(`${name} is refused and changes nothing`, async () => {
      const { doc, ctx } = await setup({ readOnly: true });
      const before = md(doc);
      const comments = doc.comments.length;
      const listed = (await documentHub().list()).length;
      const result = await runTool(name, MINIMAL_ARGS[name]!, ctx);
      assert.equal(result.isError, true, `${name} ran in Ask mode: ${result.text}`);
      assert.match(result.text, /Ask mode/);
      assert.equal(md(doc), before);
      assert.equal(doc.comments.length, comments);
      assert.equal(doc.hunks.length, 0);
      assert.equal((await documentHub().list()).length, listed);
      assert.equal((await doc.versions()).length, 0);
    });
  }

  for (const name of READ_ONLY_TOOL_NAMES) {
    test(`${name} still works`, async () => {
      const { ctx } = await setup({ readOnly: true });
      const result = await runTool(name, MINIMAL_ARGS[name]!, ctx);
      assert.doesNotMatch(result.text, /Ask mode/, `${name}: ${result.text}`);
    });
  }
});

describe("argument validation", () => {
  test("reports the bad field", async () => {
    const { ctx } = await setup();
    const result = await runTool("edit_document", { old_string: 4 }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.text, /old_string/);
    assert.match(result.text, /new_string/);
  });

  test("rejects out-of-range numbers and bad enums", async () => {
    const { ctx } = await setup();
    const limit = await runTool("read_document", { limit: 0 }, ctx);
    assert.equal(limit.isError, true);
    assert.match(limit.text, /limit/);
    const position = await runTool("insert_content", { content: "x", position: "middle" }, ctx);
    assert.equal(position.isError, true);
    assert.match(position.text, /position/);
    const level = await runTool("set_paragraph_style", { from_line: 1, type: "heading", level: 9 }, ctx);
    assert.equal(level.isError, true);
    assert.match(level.text, /level/);
  });

  test("an unknown document id is a helpful error", async () => {
    const { ctx } = await setup();
    const result = await runTool("read_document", { document_id: "nope" }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.text, /"nope" was not found\. Use list_documents/);
  });

  test("a trashed document is treated as missing", async () => {
    const { doc, ctx } = await setup();
    doc.setTrashed(true);
    const result = await runTool("read_document", {}, ctx);
    assert.equal(result.isError, true);
    assert.match(result.text, /not found/);
  });

  test("without a document id, tools use the document the user has open", async () => {
    const { doc } = await setup();
    documentHub().activeDocumentId = doc.id;
    const result = await runTool("read_document", {}, { author: "external" });
    assert.equal(result.isError, undefined);
    assert.match(result.text, new RegExp(`id ${doc.id}`));
  });
});

describe("read_document", () => {
  test("returns numbered Markdown with a header", async () => {
    const { ctx } = await setup();
    const result = await runTool("read_document", {}, ctx);
    assert.equal(result.isError, undefined);
    assert.match(result.text, /Document "Field notes"/);
    assert.match(result.text, /\s+1\t# Field notes \{\.title\}/);
    assert.match(result.text, /\s+5\t## Findings/);
    assert.match(result.text, /18 words/);
  });

  test("offset and limit page through long documents", async () => {
    const body = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n");
    const { ctx } = await setup({}, body);
    const result = await runTool("read_document", { offset: 11, limit: 5 }, ctx);
    assert.match(result.text, /\s+11\tParagraph 6\./);
    assert.match(result.text, /\s+15\tParagraph 8\./);
    assert.doesNotMatch(result.text, /Paragraph 9\./);
    assert.match(result.text, /Showing lines 11-15 of 59\. Pass offset to read further\./);
  });

  test("says when the document is empty", async () => {
    const { ctx } = await setup({}, "");
    const result = await runTool("read_document", {}, ctx);
    assert.match(result.text, /The document is empty/);
  });

  test("the header counts pending changes", async () => {
    const { ctx } = await setup();
    await runTool("edit_document", { old_string: "lazy dog", new_string: "sleepy dog" }, ctx);
    const result = await runTool("read_document", {}, ctx);
    assert.match(result.text, /1 change awaiting the user's review/);
  });

  test("reports reading activity to the editor", async () => {
    const { doc, ctx } = await setup();
    const events: HubEvent[] = [];
    doc.subscribe((event) => events.push(event));
    await runTool("read_document", {}, ctx);
    const activity = events.find((event) => event.type === "activity");
    assert.ok(activity && activity.type === "activity");
    assert.equal(activity.activity?.status, "reading");
    assert.equal(activity.activity?.chatId, "chat-test");
  });
});

describe("edit_document", () => {
  test("changes text, records a review hunk and returns edited lines", async () => {
    const { doc, ctx } = await setup();
    const result = await runTool("edit_document", { old_string: "lazy dog", new_string: "sleepy dog" }, ctx);
    assert.equal(result.isError, undefined, result.text);
    assert.match(result.text, /Edited in "Field notes"/);
    assert.match(result.text, /\s+3\tThe quick brown fox jumps over the sleepy dog\./);
    assert.match(md(doc), /sleepy dog/);
    assert.equal(doc.hunks.length, 1);
    assert.equal(doc.hunks[0]!.author, "chat-test");

    const pending = await runTool("get_pending_changes", {}, ctx);
    assert.match(pending.text, /lazy/);
    const reverted = await runTool("revert_changes", { all: true }, ctx);
    assert.equal(reverted.isError, undefined, reverted.text);
    assert.match(md(doc), /lazy dog\./);
    assert.equal(doc.hunks.length, 0);
  });

  test("errors read like Claude Code's", async () => {
    const { ctx } = await setup();
    const missing = await runTool("edit_document", { old_string: "purple cat", new_string: "x" }, ctx);
    assert.equal(missing.isError, true);
    assert.match(missing.text, /not found/i);
    const ambiguous = await runTool("edit_document", { old_string: "are", new_string: "were" }, ctx);
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.text, /Found 2 matches/);
    const same = await runTool("edit_document", { old_string: "lazy", new_string: "lazy" }, ctx);
    assert.equal(same.isError, true);
    assert.match(same.text, /exactly the same/);
    const empty = await runTool("edit_document", { old_string: "", new_string: "x" }, ctx);
    assert.equal(empty.isError, true);
    assert.match(empty.text, /insert_content/);
  });

  test("a near miss points at the closest line", async () => {
    const { ctx } = await setup();
    const result = await runTool("edit_document", { old_string: "The quick brown fox leaps over the lazy dog.", new_string: "x" }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.text, /closest line is 3/);
  });

  test("replace_all changes every occurrence", async () => {
    const { doc, ctx } = await setup();
    const result = await runTool("edit_document", { old_string: "are", new_string: "seem", replace_all: true }, ctx);
    assert.equal(result.isError, undefined, result.text);
    assert.match(result.text, /Replaced all occurrences/);
    assert.match(md(doc), /Foxes seem quick\n- Dogs seem lazy/);
  });

  test("tolerates line-number prefixes and straight quotes copied from read_document", async () => {
    const { doc, ctx } = await setup({}, "She said “hello” to the class.");
    const quoted = await runTool("edit_document", { old_string: 'said "hello"', new_string: 'said "goodbye"' }, ctx);
    assert.equal(quoted.isError, undefined, quoted.text);
    assert.match(md(doc), /said “goodbye”/);
    const prefixed = await runTool("edit_document", { old_string: "     1\tShe said “goodbye” to the class.", new_string: "She left." }, ctx);
    assert.equal(prefixed.isError, undefined, prefixed.text);
    assert.equal(md(doc), "She left.");
  });

  test("new_string can add structure: headings, lists, tables and paragraphs", async () => {
    const { doc, ctx } = await setup();
    const result = await runTool(
      "edit_document",
      { old_string: "The quick brown fox jumps over the lazy dog.", new_string: "Intro paragraph.\n\n### Data\n\n| A | B |\n| --- | --- |\n| 1 | 2 |" },
      ctx,
    );
    assert.equal(result.isError, undefined, result.text);
    const names: string[] = [];
    doc.doc.forEach((node) => names.push(node.type.name));
    assert.deepEqual(names, ["title", "paragraph", "heading", "table", "heading", "bullet_list"]);
  });

  test("an empty new_string deletes", async () => {
    const { doc, ctx } = await setup();
    const result = await runTool("edit_document", { old_string: " brown", new_string: "" }, ctx);
    assert.equal(result.isError, undefined, result.text);
    assert.match(md(doc), /The quick fox jumps/);
  });

  test("keeps formatting Markdown can't show on unchanged words", async () => {
    const { doc, ctx } = await setup();
    await runTool("format_text", { text: "quick brown fox", color: "#c5221f" }, ctx);
    await runTool("keep_changes", { all: true }, ctx);
    await runTool("edit_document", { old_string: "lazy dog", new_string: "sleepy cat" }, ctx);
    let colored = "";
    doc.doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === "text_color")) colored += node.text;
    });
    assert.equal(colored, "quick brown fox");
  });

  test("locked passages can't be edited", async () => {
    const { doc, ctx } = await setup();
    lock(doc, "lazy dog");
    const before = md(doc);
    const result = await runTool("edit_document", { old_string: "lazy dog", new_string: "cat" }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.text, /locked from AI edits/);
    assert.equal(md(doc), before);
    const elsewhere = await runTool("edit_document", { old_string: "Findings", new_string: "Results" }, ctx);
    assert.equal(elsewhere.isError, undefined, elsewhere.text);
  });

  test("notifies onChange with word counts and checkpoints once per turn", async () => {
    const changes: Array<{ tool: string; added: number; removed: number }> = [];
    let checkpoints = 0;
    const { doc, ctx } = await setup({
      onChange: (change) => changes.push(change),
      beforeWrite: async () => {
        checkpoints += 1;
      },
    });
    await runTool("edit_document", { old_string: "lazy dog", new_string: "very sleepy dog" }, ctx);
    assert.equal(checkpoints, 1);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.tool, "edit_document");
    assert.ok(changes[0]!.added >= 2, JSON.stringify(changes));
    assert.ok(changes[0]!.removed >= 1, JSON.stringify(changes));
    assert.equal(doc.activity?.status, "editing");
  });

  test("the editing range covers the changed words, at the version after the edit", async () => {
    const { doc, ctx } = await setup();
    await runTool("edit_document", { old_string: "lazy dog", new_string: "very sleepy dog" }, ctx);
    const activity = doc.activity!;
    assert.equal(activity.version, doc.version);
    assert.ok(activity.range);
    // Whole words, though the edit only inserted "very sleep" before the kept "y dog".
    assert.equal(doc.doc.textBetween(activity.range.from, activity.range.to), "very sleepy");
  });

  test("an MCP client's activity fades on its own; an in-app chat's stays until its run ends", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const external = await setup({ author: "external" });
    await runTool("edit_document", { old_string: "lazy dog", new_string: "sleepy dog" }, external.ctx);
    assert.equal(external.doc.activity?.status, "editing");
    t.mock.timers.tick(5000);
    assert.equal(external.doc.activity, null);

    const chat = await setup();
    await runTool("edit_document", { old_string: "lazy dog", new_string: "sleepy dog" }, chat.ctx);
    t.mock.timers.tick(5000);
    assert.equal(chat.doc.activity?.status, "editing");
  });

  test("a failed edit neither checkpoints nor notifies", async () => {
    let notified = false;
    const { ctx } = await setup({ onChange: () => (notified = true) });
    await runTool("edit_document", { old_string: "nothing like this", new_string: "x" }, ctx);
    assert.equal(notified, false);
  });

  test("broadcasts steps with the agent's client id and hunks", async () => {
    const { doc, ctx } = await setup();
    const events: HubEvent[] = [];
    doc.subscribe((event) => events.push(event));
    await runTool("edit_document", { old_string: "lazy dog", new_string: "sleepy dog" }, ctx);
    const steps = events.find((event) => event.type === "steps");
    assert.ok(steps && steps.type === "steps");
    assert.ok(steps.clientIDs.every((id) => id === "agent:chat-test"));
    assert.equal(steps.hunks?.length, 1);
    assert.equal(steps.hunks?.[0]!.insertedText, "sleepy");
    assert.equal(steps.hunks?.[0]!.deletedText, "lazy");
  });
});

describe("multi_edit_document", () => {
  test("applies edits in order, each on the previous result", async () => {
    const { doc, ctx } = await setup();
    const result = await runTool(
      "multi_edit_document",
      {
        edits: [
          { old_string: "lazy dog", new_string: "sleepy dog" },
          { old_string: "sleepy dog.", new_string: "sleepy dog, twice." },
          { old_string: "Findings", new_string: "Results" },
        ],
      },
      ctx,
    );
    assert.equal(result.isError, undefined, result.text);
    assert.match(result.text, /Applied 3 edits/);
    assert.match(md(doc), /sleepy dog, twice\./);
    assert.match(md(doc), /## Results/);
  });

  test("is atomic: one failing edit applies none", async () => {
    const { doc, ctx } = await setup();
    const before = md(doc);
    const result = await runTool(
      "multi_edit_document",
      { edits: [{ old_string: "lazy dog", new_string: "sleepy dog" }, { old_string: "missing text", new_string: "x" }] },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.match(result.text, /Edit 2 of 2 failed, so no edits were applied/);
    assert.equal(md(doc), before);
    assert.equal(doc.hunks.length, 0);
  });

  test("requires at least one edit", async () => {
    const { ctx } = await setup();
    const result = await runTool("multi_edit_document", { edits: [] }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.text, /edits/);
  });
});

describe("write_document", () => {
  test("rewrites the document and only real differences become hunks", async () => {
    const { doc, ctx } = await setup();
    const next = SAMPLE.replace("lazy dog.", "lazy cat.");
    const result = await runTool("write_document", { content: next }, ctx);
    assert.equal(result.isError, undefined, result.text);
    assert.equal(md(doc), next);
    assert.equal(doc.hunks.length, 1);
    assert.equal(doc.hunksJSON()[0]!.insertedText, "cat");
  });

  test("drafts into an empty document", async () => {
    const { doc, ctx } = await setup({}, "");
    const result = await runTool("write_document", { content: "# Plan {.title}\n\nFirst step." }, ctx);
    assert.equal(result.isError, undefined, result.text);
    assert.equal(md(doc), "# Plan {.title}\n\nFirst step.");
  });

  test("writing identical content is reported as no change", async () => {
    const { ctx } = await setup();
    const result = await runTool("write_document", { content: SAMPLE }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.text, /no change/);
  });

  test("can't remove a locked passage", async () => {
    const { doc, ctx } = await setup();
    lock(doc, "lazy dog");
    const result = await runTool("write_document", { content: "Something else entirely." }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.text, /locked/);
    assert.match(md(doc), /lazy dog/);
  });
});

describe("insert_content", () => {
  test("inserts at start and end", async () => {
    const { doc, ctx } = await setup();
    await runTool("insert_content", { content: "Preface.", position: "start" }, ctx);
    await runTool("insert_content", { content: "## Appendix\n\nMore.", position: "end" }, ctx);
    assert.match(md(doc), /^Preface\.\n\n# Field notes/);
    assert.match(md(doc), /## Appendix\n\nMore\.$/);
  });

  test("before_line and after_line place blocks around a line", async () => {
    const { doc, ctx } = await setup();
    await runTool("insert_content", { content: "Before findings.", position: "before_line", line: 5 }, ctx);
    assert.match(md(doc), /lazy dog\.\n\nBefore findings\.\n\n## Findings/);
    await runTool("insert_content", { content: "After the title.", position: "after_line", line: 1 }, ctx);
    assert.match(md(doc), /\{\.title\}\n\nAfter the title\.\n\nThe quick/);
  });

  test("a list item joins the list it's inserted into", async () => {
    const { doc, ctx } = await setup();
    const result = await runTool("insert_content", { content: "- Birds are loud", position: "after_line", line: 7 }, ctx);
    assert.equal(result.isError, undefined, result.text);
    assert.match(md(doc), /- Foxes are quick\n- Birds are loud\n- Dogs are lazy/);
    let lists = 0;
    doc.doc.forEach((node) => {
      if (node.type.name === "bullet_list") lists += 1;
    });
    assert.equal(lists, 1);
  });

  test("a list item added at the end or start joins the list there", async () => {
    const { doc, ctx } = await setup({}, "- Apples\n- Bread");
    const end = await runTool("insert_content", { content: "- Milk", position: "end" }, ctx);
    assert.equal(end.isError, undefined, end.text);
    const start = await runTool("insert_content", { content: "- Eggs", position: "start" }, ctx);
    assert.equal(start.isError, undefined, start.text);
    assert.equal(md(doc), "- Eggs\n- Apples\n- Bread\n- Milk");
    assert.equal(doc.doc.childCount, 1);
    const numbered = await setup({}, "Steps:\n\n1. Mix\n2. Bake");
    await runTool("insert_content", { content: "3. Serve", position: "end" }, numbered.ctx);
    assert.equal(md(numbered.doc), "Steps:\n\n1. Mix\n2. Bake\n3. Serve");
    const paragraph = await setup({}, "- Apples");
    await runTool("insert_content", { content: "A closing paragraph.", position: "end" }, paragraph.ctx);
    assert.equal(md(paragraph.doc), "- Apples\n\nA closing paragraph.");
  });

  test("a line past the end appends", async () => {
    const { doc, ctx } = await setup();
    const result = await runTool("insert_content", { content: "Tail.", position: "after_line", line: 500 }, ctx);
    assert.equal(result.isError, undefined, result.text);
    assert.match(md(doc), /Tail\.$/);
  });

  test("line is required for line positions, and empty Markdown is rejected", async () => {
    const { ctx } = await setup();
    const noLine = await runTool("insert_content", { content: "x", position: "after_line" }, ctx);
    assert.equal(noLine.isError, true);
    assert.match(noLine.text, /line is required/);
    const nothing = await runTool("insert_content", { content: "   ", position: "end" }, ctx);
    assert.equal(nothing.isError, true);
    assert.match(nothing.text, /Nothing to insert/);
  });
});

describe("search_document", () => {
  test("finds lines by substring, case-insensitively by default", async () => {
    const { ctx } = await setup();
    const result = await runTool("search_document", { pattern: "LAZY" }, ctx);
    assert.match(result.text, /^2 matching lines in "Field notes":/);
    assert.match(result.text, /\s+3\tThe quick/);
    assert.match(result.text, /\s+8\t- Dogs are lazy/);
  });

  test("case_sensitive and regex options", async () => {
    const { ctx } = await setup();
    const sensitive = await runTool("search_document", { pattern: "LAZY", case_sensitive: true }, ctx);
    assert.match(sensitive.text, /No lines match/);
    const regex = await runTool("search_document", { pattern: "^- \\w+ are", regex: true }, ctx);
    assert.match(regex.text, /^2 matching lines/);
  });

  test("an invalid regex is a clear error", async () => {
    const { ctx } = await setup();
    const result = await runTool("search_document", { pattern: "(", regex: true }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.text, /Invalid regular expression/);
  });

  test("caps output at 100 lines and says how many matched", async () => {
    const body = Array.from({ length: 120 }, (_, i) => `Needle ${i}.`).join("\n\n");
    const { ctx } = await setup({}, body);
    const result = await runTool("search_document", { pattern: "needle" }, ctx);
    assert.match(result.text, /^120 matching lines in "Field notes" \(showing 100\)/);
  });
});

describe("get_outline", () => {
  test("lists headings with line numbers and section word counts", async () => {
    const { ctx } = await setup();
    const result = await runTool("get_outline", {}, ctx);
    assert.match(result.text, /\s+1\t\[title\] Field notes — 9 words/);
    assert.match(result.text, /\s+5\t {2}## Findings — 6 words/);
    assert.match(result.text, /Total: 18 words\./);
  });

  test("handles documents without headings", async () => {
    const { ctx } = await setup({}, "Just text here.");
    const result = await runTool("get_outline", {}, ctx);
    assert.match(result.text, /\(start\) — 3 words/);
  });
});

describe("format_text", () => {
  test("bolds and colors text found by plain text", async () => {
    const { doc, ctx } = await setup();
    const result = await runTool("format_text", { text: "quick brown fox", bold: true, color: "#c5221f" }, ctx);
    assert.equal(result.isError, undefined, result.text);
    assert.match(md(doc), /\*\*quick brown fox\*\*/);
    assert.equal(doc.hunks.length, 1, "formatting is reviewable");
  });

  test("ambiguous text needs occurrence or all", async () => {
    const { doc, ctx } = await setup();
    const ambiguous = await runTool("format_text", { text: "are", italic: true }, ctx);
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.text, /appears 2 times \(lines 7, 8\)/);
    const second = await runTool("format_text", { text: "are", italic: true, occurrence: 2 }, ctx);
    assert.equal(second.isError, undefined, second.text);
    assert.match(md(doc), /Foxes are quick\n- Dogs \*are\* lazy/);
    const tooFar = await runTool("format_text", { text: "are", italic: true, occurrence: 3 }, ctx);
    assert.equal(tooFar.isError, true);
    assert.match(tooFar.text, /Only 2 matches/);
  });

  test("all: true formats every match", async () => {
    const { doc, ctx } = await setup();
    await runTool("format_text", { text: "are", underline: true, all: true }, ctx);
    assert.match(md(doc), /Foxes <u>are<\/u> quick\n- Dogs <u>are<\/u> lazy/);
  });

  test("a line range formats whole blocks", async () => {
    const { doc, ctx } = await setup();
    const result = await runTool("format_text", { from_line: 7, to_line: 8, strikethrough: true }, ctx);
    assert.equal(result.isError, undefined, result.text);
    assert.match(md(doc), /- ~~Foxes are quick~~\n- ~~Dogs are lazy~~/);
  });

  test("text plus a line range restricts the search", async () => {
    const { doc, ctx } = await setup();
    const result = await runTool("format_text", { text: "are", from_line: 8, to_line: 8, code: true }, ctx);
    assert.equal(result.isError, undefined, result.text);
    assert.match(md(doc), /Dogs `are` lazy/);
    const missing = await runTool("format_text", { text: "brown", from_line: 7, to_line: 8, bold: true }, ctx);
    assert.equal(missing.isError, true);
    assert.match(missing.text, /between lines 7 and 8/);
  });

  test("font labels resolve to CSS families, and properties can be removed", async () => {
    const { doc, ctx } = await setup();
    await runTool("format_text", { text: "lazy dog", font_family: "georgia", font_size: 14, highlight: true, link: "https://example.com" }, ctx);
    const marks = new Map<string, unknown>();
    doc.doc.descendants((node) => {
      if (node.isText && node.text === "lazy dog") for (const mark of node.marks) marks.set(mark.type.name, mark.attrs);
    });
    assert.deepEqual({ ...(marks.get("font_family") as object) }, { family: "Georgia, serif" });
    assert.ok(marks.has("font_size"));
    assert.ok(marks.has("highlight"));
    assert.ok(marks.has("link"));
    await runTool("format_text", { text: "lazy dog", font_family: null, font_size: null, highlight: false, link: null }, ctx);
    doc.doc.descendants((node) => {
      if (node.isText && node.text?.includes("lazy dog")) {
        assert.deepEqual(
          node.marks.map((mark) => mark.type.name),
          [],
        );
      }
    });
  });

  test("needs formatting and a target", async () => {
    const { ctx } = await setup();
    const noSpec = await runTool("format_text", { text: "fox" }, ctx);
    assert.equal(noSpec.isError, true);
    assert.match(noSpec.text, /No formatting given/);
    const noTarget = await runTool("format_text", { bold: true }, ctx);
    assert.equal(noTarget.isError, true);
    assert.match(noTarget.text, /Pass `text`, a line range/);
  });

  test("refuses locked text", async () => {
    const { doc, ctx } = await setup();
    lock(doc, "lazy dog");
    const result = await runTool("format_text", { text: "lazy dog", bold: true }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.text, /locked/);
  });
});

describe("set_paragraph_style", () => {
  test("turns a paragraph into a heading and back", async () => {
    const { doc, ctx } = await setup();
    const heading = await runTool("set_paragraph_style", { from_line: 3, type: "heading", level: 3 }, ctx);
    assert.equal(heading.isError, undefined, heading.text);
    assert.match(heading.text, /Restyled lines 3/);
    assert.match(md(doc), /### The quick brown fox/);
    await runTool("set_paragraph_style", { from_line: 3, type: "paragraph" }, ctx);
    assert.match(md(doc), /\n\nThe quick brown fox/);
  });

  test("alignment, indent and spacing", async () => {
    const { doc, ctx } = await setup();
    await runTool("set_paragraph_style", { from_line: 3, align: "justify", indent: 2, line_spacing: 2, space_before: 6, space_after: 12 }, ctx);
    const para = doc.doc.child(1);
    assert.equal(para.attrs.align, "justify");
    assert.equal(para.attrs.indent, 2);
    assert.match(md(doc), /\{align=justify indent=2\}|\{indent=2 align=justify\}|align=justify/);
    const settings = await runTool("read_document", {}, ctx);
    assert.match(settings.text, /align=justify/);
  });

  test("a range restyles every block in it", async () => {
    const { doc, ctx } = await setup();
    const result = await runTool("set_paragraph_style", { from_line: 1, to_line: 3, align: "center" }, ctx);
    assert.match(result.text, /Restyled lines 1-3/);
    assert.equal(doc.doc.child(0).attrs.align, "center");
    assert.equal(doc.doc.child(1).attrs.align, "center");
    assert.notEqual(doc.doc.child(2).attrs.align, "center");
  });
});

describe("document settings", () => {
  test("get returns the title and page setup as JSON", async () => {
    const { ctx } = await setup();
    const result = await runTool("get_document_settings", {}, ctx);
    const settings = JSON.parse(result.text);
    assert.equal(settings.title, "Field notes");
    assert.equal(settings.pageSetup.paperSize, "letter");
    assert.equal(settings.fontSize, 11);
  });

  test("update changes only the fields passed and emits meta", async () => {
    const changes: string[] = [];
    const { doc, ctx } = await setup({ onChange: (change) => changes.push(change.tool) });
    const events: HubEvent[] = [];
    doc.subscribe((event) => events.push(event));
    const result = await runTool(
      "update_document_settings",
      {
        title: "Renamed",
        font_family: "Times New Roman",
        margins: { left: 1.5 },
        orientation: "landscape",
        header: "{title}",
        page_numbers: { enabled: true, align: "center" },
      },
      ctx,
    );
    assert.equal(result.isError, undefined, result.text);
    assert.equal(doc.meta.title, "Renamed");
    assert.equal(doc.meta.settings.fontFamily, '"Times New Roman", Times, serif');
    assert.deepEqual(doc.meta.settings.pageSetup.margins, { top: 1, right: 1, bottom: 1, left: 1.5 });
    assert.equal(doc.meta.settings.pageSetup.orientation, "landscape");
    assert.equal(doc.meta.settings.pageSetup.paperSize, "letter");
    assert.equal(doc.meta.settings.headerFooter.header, "{title}");
    assert.equal(doc.meta.settings.pageNumbers.enabled, true);
    assert.equal(doc.meta.settings.pageNumbers.align, "center");
    assert.equal(doc.meta.settings.pageNumbers.position, "footer");
    assert.equal(doc.meta.settings.fontSize, 11);
    assert.ok(events.some((event) => event.type === "meta"));
    assert.deepEqual(changes, ["update_document_settings"]);
  });

  test("update with nothing to change fails", async () => {
    const { ctx } = await setup();
    const result = await runTool("update_document_settings", {}, ctx);
    assert.equal(result.isError, true);
    assert.match(result.text, /No settings given/);
  });
});

describe("get_editor_context", () => {
  test("reports the selection with line numbers", async () => {
    const { doc, ctx } = await setup();
    const from = findText(doc.doc, "brown fox");
    doc.setSelection({ from, to: from + "brown fox".length, version: doc.version });
    const result = await runTool("get_editor_context", {}, ctx);
    assert.match(result.text, /Selection \(lines 3-3\):\n"""\nbrown fox\n"""/);
    assert.match(result.text, /No open comments\./);
    assert.match(result.text, /No pending changes\./);
  });

  test("reports a cursor without selection, comments, pending changes and editor mode", async () => {
    const { doc, ctx } = await setup();
    const at = findText(doc.doc, "Dogs");
    doc.setSelection({ from: at, to: at, version: doc.version });
    await runTool("add_comment", { text: "jumps", comment: "Check" }, ctx);
    await runTool("edit_document", { old_string: "Findings", new_string: "Results" }, ctx);
    doc.editorMode = "suggesting";
    const result = await runTool("get_editor_context", {}, ctx);
    assert.match(result.text, /Cursor is on line 8; nothing is selected\./);
    assert.match(result.text, /1 open comment \(use list_comments\)/);
    assert.match(result.text, /1 change by Claude awaiting review/);
    assert.match(result.text, /editor is in suggesting mode/);
  });

  test("a selection from an older version is ignored", async () => {
    const { doc, ctx } = await setup();
    doc.setSelection({ from: 1, to: 5, version: doc.version + 7 });
    const result = await runTool("get_editor_context", {}, ctx);
    assert.match(result.text, /no active selection/);
  });

  test("the selection follows edits made after it", async () => {
    const { doc, ctx } = await setup();
    const from = findText(doc.doc, "lazy dog");
    doc.setSelection({ from, to: from + 8, version: doc.version });
    await runTool("edit_document", { old_string: "The quick", new_string: "A very quick" }, ctx);
    const result = await runTool("get_editor_context", {}, ctx);
    assert.match(result.text, /"""\nlazy dog\n"""/);
  });
});

describe("review tools", () => {
  test("pending changes list Claude's edits with ids and lines", async () => {
    const { doc, ctx } = await setup();
    await runTool("edit_document", { old_string: "lazy dog", new_string: "sleepy dog" }, ctx);
    await runTool("edit_document", { old_string: "Findings", new_string: "Results" }, ctx);
    const result = await runTool("get_pending_changes", {}, ctx);
    assert.match(result.text, /^2 pending changes in "Field notes":/);
    const [first, second] = doc.hunks;
    assert.match(result.text, new RegExp(`- ${first!.id} \\(line 3, by Claude\\): "lazy" → "sleepy"`));
    assert.match(result.text, new RegExp(`- ${second!.id} \\(line 5, by Claude\\): "Findings" → "Results"`));
  });

  test("keep and revert by id leave the other changes pending", async () => {
    const { doc, ctx } = await setup();
    await runTool("edit_document", { old_string: "lazy dog", new_string: "sleepy dog" }, ctx);
    await runTool("edit_document", { old_string: "Findings", new_string: "Results" }, ctx);
    await runTool("edit_document", { old_string: "Foxes", new_string: "Wolves" }, ctx);
    const [a, b, c] = doc.hunks;
    const kept = await runTool("keep_changes", { change_ids: [a!.id] }, ctx);
    assert.match(kept.text, /Kept 1 change/);
    const reverted = await runTool("revert_changes", { change_ids: [c!.id] }, ctx);
    assert.match(reverted.text, /Reverted 1 change/);
    assert.deepEqual(
      doc.hunks.map((hunk) => hunk.id),
      [b!.id],
    );
    assert.match(md(doc), /sleepy dog/);
    assert.match(md(doc), /## Results/);
    assert.match(md(doc), /- Foxes are quick/);
  });

  test("keep and revert need ids or all, and matching changes", async () => {
    const { ctx } = await setup();
    for (const name of ["keep_changes", "revert_changes"]) {
      const none = await runTool(name, {}, ctx);
      assert.equal(none.isError, true);
      assert.match(none.text, /Pass change_ids or all: true/);
      const nothing = await runTool(name, { all: true }, ctx);
      assert.equal(nothing.isError, true);
      assert.match(nothing.text, /No matching pending changes/);
      const unknown = await runTool(name, { change_ids: ["nope"] }, ctx);
      assert.equal(unknown.isError, true);
    }
  });

  test("successive edits to the same words merge into one change that undoes to the original", async () => {
    const { doc, ctx } = await setup();
    await runTool("edit_document", { old_string: "lazy dog", new_string: "sleepy dog" }, ctx);
    await runTool("edit_document", { old_string: "sleepy dog", new_string: "drowsy hound" }, ctx);
    assert.equal(doc.hunks.length, 1);
    await runTool("revert_changes", { all: true }, ctx);
    assert.equal(md(doc), SAMPLE);
  });

  test("one edit that changes several words becomes separate changes that each undo cleanly", async () => {
    const { doc, ctx } = await setup();
    await runTool("edit_document", { old_string: "The quick brown fox jumps over the lazy dog.", new_string: "A quick brown fox leapt over the lazy cat." }, ctx);
    const hunks = doc.hunksJSON();
    assert.ok(hunks.length >= 2, JSON.stringify(hunks.map((hunk) => [hunk.deletedText, hunk.insertedText])));
    for (let i = 1; i < hunks.length; i += 1) assert.ok(hunks[i - 1]!.to <= hunks[i]!.from, "changes don't overlap");
    await runTool("revert_changes", { change_ids: [hunks.at(-1)!.id] }, ctx);
    assert.match(md(doc), /A quick brown fox leapt over the lazy dog\./);
    await runTool("revert_changes", { all: true }, ctx);
    assert.equal(md(doc), SAMPLE);
  });

  test("editing back to the original clears the change", async () => {
    const { doc, ctx } = await setup();
    await runTool("edit_document", { old_string: "lazy dog", new_string: "sleepy dog" }, ctx);
    await runTool("edit_document", { old_string: "sleepy dog", new_string: "lazy dog" }, ctx);
    assert.equal(doc.hunks.length, 0);
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
    const context = await runTool("get_editor_context", {}, ctx);
    assert.match(context.text, /1 suggestion by the user/);
    const kept = await runTool("keep_changes", { all: true }, ctx);
    assert.equal(kept.isError, undefined, kept.text);
    assert.equal(doc.hunks.length, 0);
    assert.match(md(doc), /sleepy dog/);

    // Plain edits are not tracked.
    doc.receiveClientSteps(doc.version, [new ReplaceStep(pos, pos + 6, new Slice(Fragment.from(schema.text("lazy")), 0, 0)).toJSON()], "client-1");
    assert.equal(doc.hunks.length, 0);
  });

  test("Claude's pending edit survives the user typing elsewhere, and still undoes cleanly", async () => {
    const { doc, ctx } = await setup();
    await runTool("edit_document", { old_string: "Findings", new_string: "Results" }, ctx);
    const pos = findText(doc.doc, "The quick");
    doc.receiveClientSteps(doc.version, [new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text("Note: ")), 0, 0)).toJSON()], "client-1");
    await runTool("revert_changes", { all: true }, ctx);
    assert.match(md(doc), /Note: The quick/);
    assert.match(md(doc), /## Findings/);
  });
});

describe("comments", () => {
  test("add, list, reply and resolve", async () => {
    const { doc, ctx } = await setup();
    const added = await runTool("add_comment", { text: "jumps over", comment: "Is this accurate?" }, ctx);
    assert.equal(added.isError, undefined, added.text);
    const id = added.text.match(/Added comment (\S+) on line 3\./)?.[1];
    assert.ok(id, added.text);
    assert.equal(doc.hunks.length, 0, "comments are not content changes");

    const listed = await runTool("list_comments", {}, ctx);
    assert.match(listed.text, new RegExp(`- \\[${id}\\] Claude on "jumps over": Is this accurate\\?`));

    doc.replyToComment(id, "Yes, checked.", "user");
    const replied = await runTool("reply_to_comment", { comment_id: id, reply: "Thanks, leaving it.", resolve: true }, ctx);
    assert.match(replied.text, /Replied to .* and resolved it/);
    assert.match((await runTool("list_comments", {}, ctx)).text, /No open comments/);
    const all = await runTool("list_comments", { include_resolved: true }, ctx);
    assert.match(all.text, /\(resolved\)/);
    assert.match(all.text, /↳ User: Yes, checked\./);
    assert.match(all.text, /↳ Claude: Thanks, leaving it\./);

    const reopened = await runTool("resolve_comment", { comment_id: id, resolved: false }, ctx);
    assert.match(reopened.text, /Reopened/);
    assert.equal(doc.comments[0]!.resolved, false);
  });

  test("a comment whose anchor text was deleted shows the original quote", async () => {
    const { ctx } = await setup();
    await runTool("add_comment", { text: "lazy dog", comment: "Too harsh." }, ctx);
    await runTool("edit_document", { old_string: " over the lazy dog", new_string: "" }, ctx);
    const listed = await runTool("list_comments", {}, ctx);
    assert.match(listed.text, /anchor text was deleted; originally "lazy dog"/);
  });

  test("ambiguous and missing anchors", async () => {
    const { ctx } = await setup();
    const ambiguous = await runTool("add_comment", { text: "are", comment: "x" }, ctx);
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.text, /appears 2 times/);
    const second = await runTool("add_comment", { text: "are", comment: "x", occurrence: 2 }, ctx);
    assert.match(second.text, /on line 8/);
    const missing = await runTool("add_comment", { text: "unicorn", comment: "x" }, ctx);
    assert.equal(missing.isError, true);
    assert.match(missing.text, /Text not found/);
    const tooFar = await runTool("add_comment", { text: "are", comment: "x", occurrence: 5 }, ctx);
    assert.equal(tooFar.isError, true);
  });

  test("replying to or resolving an unknown comment fails", async () => {
    const { ctx } = await setup();
    const reply = await runTool("reply_to_comment", { comment_id: "missing", reply: "x" }, ctx);
    assert.equal(reply.isError, true);
    assert.match(reply.text, /No comment with id missing/);
    const resolve = await runTool("resolve_comment", { comment_id: "missing" }, ctx);
    assert.equal(resolve.isError, true);
  });
});

describe("analyze_writing", () => {
  test("reports statistics for the document", async () => {
    const { ctx } = await setup();
    const result = await runTool("analyze_writing", {}, ctx);
    assert.equal(result.isError, undefined, result.text);
    assert.match(result.text, /Writing analysis of "Field notes":/);
    assert.match(result.text, /Words: 18/);
    assert.match(result.text, /Reading ease/);
  });

  test("detects AI-writing tropes", async () => {
    const { ctx } = await setup({}, "Let's delve into the rich tapestry of ideas — truly a testament to innovation — in today's fast-paced world.");
    const result = await runTool("analyze_writing", {}, ctx);
    assert.match(result.text, /AI-writing tropes:/);
    assert.match(result.text, /delve/i);
  });

  test("a line range analyses only those lines", async () => {
    const { ctx } = await setup();
    const result = await runTool("analyze_writing", { from_line: 7, to_line: 8 }, ctx);
    assert.match(result.text, /\(lines 7-8\)/);
    assert.match(result.text, /Words: 6/);
  });
});

describe("count_words", () => {
  test("counts the document as the editor's word count does", async () => {
    const { ctx } = await setup();
    const result = await runTool("count_words", {}, ctx);
    assert.equal(result.isError, undefined, result.text);
    assert.match(result.text, /^"Field notes": 18 words\./);
    assert.match(result.text, /Paragraphs: 5/);
  });

  test("counts a draft without counting its Markdown", async () => {
    const { ctx } = await setup();
    const result = await runTool("count_words", { text: "## A **bold** start {align=center}\n\n- one item\n- two items", target_words: 10 }, ctx);
    assert.match(result.text, /^The text: 7 words \(3 short of the 10 asked for\)\./);
  });

  test("counts a line range and reports hitting the target", async () => {
    const { ctx } = await setup();
    const result = await runTool("count_words", { from_line: 3, to_line: 3, target_words: 9 }, ctx);
    assert.match(result.text, /^Lines 3-3 of "Field notes": 9 words \(exactly the 9 asked for\)\./);
    const over = await runTool("count_words", { from_line: 3, to_line: 3, target_words: 5 }, ctx);
    assert.match(over.text, /4 over the 5 asked for/);
  });

  test("text and a line range together are refused", async () => {
    const { ctx } = await setup();
    const result = await runTool("count_words", { text: "x", from_line: 1 }, ctx);
    assert.equal(result.isError, true);
  });
});

describe("get_page_count", () => {
  test("estimates from the word count when no editor has measured the text", async () => {
    const { ctx } = await setup({}, Array.from({ length: 40 }, () => "word ".repeat(50).trim()).join("\n\n"));
    const result = await runTool("get_page_count", {}, ctx);
    assert.equal(result.isError, undefined, result.text);
    assert.match(result.text, /fills about \d+ pages .*estimated from the word count/);
    assert.match(result.text, /2,000 words; about [\d,]+ words fit on a full page/);
  });

  test("uses the layout the editor reported for the current version", async () => {
    const { doc, ctx } = await setup();
    const third = findText(doc.doc, "Findings");
    doc.setLayout({ version: doc.version, pages: 2, starts: [third], lastPageFill: 0.25 });
    const result = await runTool("get_page_count", {}, ctx);
    assert.match(result.text, /fills 2 pages, as laid out in the user's editor \(Letter portrait, 1" margins/);
    assert.match(result.text, /Page 2 starts on line 5: “Findings…”/);
    assert.match(result.text, /The last page is about 25% full/);
    // The header other tools print uses the measured count too.
    const read = await runTool("read_document", {}, ctx);
    assert.match(read.text, / · 2 pages · /);
  });

  test("a layout for an older version is not used as the count", async () => {
    const { doc, ctx } = await setup();
    doc.setLayout({ version: doc.version, pages: 4, starts: [], lastPageFill: 0.5 });
    await runTool("insert_content", { content: "More text.", position: "end" }, ctx);
    const result = await runTool("get_page_count", {}, ctx);
    assert.match(result.text, /fills about 1 page .*estimated/);
  });

  test("waits for an open editor to measure the latest change", async () => {
    const { doc, ctx } = await setup();
    const stop = doc.subscribe(() => undefined);
    try {
      setTimeout(() => doc.setLayout({ version: doc.version, pages: 3, starts: [], lastPageFill: 0.5 }), 50);
      const result = await runTool("get_page_count", {}, ctx);
      assert.match(result.text, /fills 3 pages, as laid out/);
    } finally {
      stop();
    }
  });
});

describe("documents", () => {
  test("create, list and open", async () => {
    const { doc, ctx } = await setup();
    const commands: unknown[] = [];
    doc.subscribe((event) => event.type === "command" && commands.push(event.command));
    const created = await runTool("create_document", { title: "Plan", content: "# Plan {.title}\n\nStep one." }, ctx);
    assert.equal(created.isError, undefined, created.text);
    const id = created.text.match(/\(id (\S+)\)/)?.[1];
    assert.ok(id);
    assert.deepEqual(commands, [{ kind: "open_document", documentId: id }], "the user's editor switches to it");

    const listed = await runTool("list_documents", {}, ctx);
    assert.match(listed.text, new RegExp(`- ${id}: "Plan" · 3 words`));
    assert.match(listed.text, new RegExp(`- ${doc.id} \\(open\\): "Field notes"`));

    const opened = await runTool("open_document", { document_id: id }, ctx);
    assert.match(opened.text, /Opened "Plan"/);
    const read = await runTool("read_document", { document_id: id }, ctx);
    assert.match(read.text, /Step one\./);
  });

  test("create with open: false doesn't switch the editor", async () => {
    const { doc, ctx } = await setup();
    let commands = 0;
    doc.subscribe((event) => event.type === "command" && (commands += 1));
    await runTool("create_document", { title: "Background", open: false }, ctx);
    assert.equal(commands, 0);
  });

  test("open says when no editor is showing", async () => {
    const { doc, ctx } = await setup();
    const result = await runTool("open_document", { document_id: doc.id }, ctx);
    assert.match(result.text, /the user has no editor open/);
    const missing = await runTool("open_document", { document_id: "missing" }, ctx);
    assert.equal(missing.isError, true);
  });

  test("trashed documents are listed only on request", async () => {
    const { doc, ctx } = await setup();
    doc.setTrashed(true);
    const listed = await runTool("list_documents", {}, ctx);
    assert.doesNotMatch(listed.text, new RegExp(doc.id));
    const trashed = await runTool("list_documents", { include_trashed: true }, ctx);
    assert.match(trashed.text, new RegExp(doc.id));
  });
});

describe("versions", () => {
  test("save, list and restore", async () => {
    const { doc, ctx } = await setup();
    const saved = await runTool("save_version", { label: "Draft 1" }, ctx);
    assert.equal(saved.isError, undefined, saved.text);
    await runTool("edit_document", { old_string: "quick brown", new_string: "slow red" }, ctx);
    const versions = await runTool("list_versions", {}, ctx);
    const id = versions.text.match(/^- (\S+): "Draft 1" · claude/m)?.[1];
    assert.ok(id, versions.text);
    const restored = await runTool("restore_version", { version_id: id }, ctx);
    assert.equal(restored.isError, undefined, restored.text);
    assert.match(restored.text, /Restored "Field notes" to "Draft 1"/);
    assert.equal(md(doc), SAMPLE);
    assert.equal(doc.hunks.length, 0, "a restore clears pending changes");
    const after = await runTool("list_versions", {}, ctx);
    assert.match(after.text, /"Before restoring a version" · auto/);
  });

  test("no versions yet, and unknown or unsafe ids", async () => {
    const { ctx } = await setup();
    assert.match((await runTool("list_versions", {}, ctx)).text, /No saved versions/);
    const missing = await runTool("restore_version", { version_id: "missing" }, ctx);
    assert.equal(missing.isError, true);
    assert.match(missing.text, /Version not found/);
    const traversal = await runTool("restore_version", { version_id: "../../documents/x" }, ctx);
    assert.equal(traversal.isError, true);
  });
});

describe("export_document", () => {
  test("downloads into the open editor and returns the URL", async () => {
    const { doc, ctx } = await setup();
    const commands: unknown[] = [];
    doc.subscribe((event) => event.type === "command" && commands.push(event.command));
    const result = await runTool("export_document", { format: "docx" }, ctx);
    assert.equal(result.isError, undefined, result.text);
    assert.match(result.text, /Started the download of "Field notes\.docx"/);
    assert.match(result.text, new RegExp(`/api/documents/${doc.id}/export\\?format=docx`));
    assert.deepEqual(commands, [{ kind: "download", url: `/api/documents/${doc.id}/export?format=docx`, filename: "Field notes.docx" }]);
  });

  test("file names drop characters the file system rejects", async () => {
    const { doc, ctx } = await setup();
    doc.updateMeta({ title: 'Q3: plan/review "v2"' });
    doc.subscribe(() => undefined);
    const result = await runTool("export_document", { format: "md" }, ctx);
    assert.match(result.text, /"Q3- plan-review -v2-\.md"/);
  });

  test("PDF needs an open editor", async () => {
    const { doc, ctx } = await setup();
    const offline = await runTool("export_document", { format: "pdf" }, ctx);
    assert.equal(offline.isError, true);
    assert.match(offline.text, /needs the document open/);
    const commands: unknown[] = [];
    doc.subscribe((event) => event.type === "command" && commands.push(event.command));
    const online = await runTool("export_document", { format: "pdf" }, ctx);
    assert.equal(online.isError, undefined);
    assert.match(online.text, /Started the download of "Field notes\.pdf"/);
    assert.deepEqual(commands, [{ kind: "export_pdf" }], "the editor draws the PDF from its own page layout");
  });
});

describe("analysis tools never change the document", () => {
  for (const name of READ_ONLY_TOOL_NAMES) {
    test(name, async () => {
      const { doc, ctx } = await setup();
      const version = doc.version;
      const before = md(doc);
      await runTool(name, MINIMAL_ARGS[name]!, ctx);
      assert.equal(doc.version, version);
      assert.equal(md(doc), before);
      assert.equal(doc.hunks.length, 0);
    });
  }
});

describe("comments, locks, images and attachments", () => {
  test("delete_comment removes the comment and its highlight", async () => {
    const { doc, ctx } = await setup();
    const added = await runTool("add_comment", { text: "lazy dog", comment: "Too harsh?" }, ctx);
    const id = /Added comment (\S+)/.exec(added.text)![1]!;
    const result = await runTool("delete_comment", { comment_id: id }, ctx);
    assert.ok(!result.isError, result.text);
    assert.equal(doc.comments.length, 0);
    let marked = false;
    doc.doc.descendants((node) => {
      if (node.marks.some((mark) => mark.type.name === "comment")) marked = true;
    });
    assert.equal(marked, false);
    assert.equal((await runTool("delete_comment", { comment_id: id }, ctx)).isError, true);
  });

  test("lock_text protects a passage from Claude's edits until unlocked, and isn't a pending change", async () => {
    const { doc, ctx } = await setup();
    assert.ok(!(await runTool("lock_text", { text: "lazy dog" }, ctx)).isError);
    assert.equal(doc.hunks.length, 0, "locking is not a content change");
    assert.match((await runTool("list_locked_text", {}, ctx)).text, /line 3: "lazy dog"/);
    const blocked = await runTool("edit_document", { old_string: "lazy dog", new_string: "sleepy dog" }, ctx);
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /locked/);
    assert.ok(!(await runTool("lock_text", { text: "lazy dog", locked: false }, ctx)).isError);
    assert.equal((await runTool("list_locked_text", {}, ctx)).text, "Nothing is locked.");
    assert.ok(!(await runTool("edit_document", { old_string: "lazy dog", new_string: "sleepy dog" }, ctx)).isError);
  });

  test("lock_text asks which copy when the text repeats", async () => {
    const { ctx } = await setup({}, "Same words.\n\nSame words.");
    assert.match((await runTool("lock_text", { text: "Same words" }, ctx)).text, /appears 2 times/);
    assert.match((await runTool("lock_text", { text: "Same words", all: true }, ctx)).text, /Locked 2 passages/);
  });

  test("insert_image places an attached image or a web image as a reviewable block", async () => {
    const { saveUpload } = await import("@/lib/server/store");
    await saveUpload("pic1", "png", new Uint8Array([1, 2, 3]));
    await saveUpload("notes9", "txt", new TextEncoder().encode("hello"));
    const { doc, ctx } = await setup();
    const result = await runTool("insert_image", { attachment_id: "pic1", alt: "Chart", width: 320, position: "after_line", line: 1 }, ctx);
    assert.ok(!result.isError, result.text);
    assert.match(md(doc), /!\[Chart\]\(\/api\/uploads\/pic1\.png\)\{width=320/);
    assert.equal(doc.hunks.length, 1);
    assert.match((await runTool("insert_image", { attachment_id: "notes9", position: "end" }, ctx)).text, /isn't an image/);
    assert.match((await runTool("insert_image", { url: "javascript:alert(1)", position: "end" }, ctx)).text, /must start with/);
    assert.match((await runTool("insert_image", { position: "end" }, ctx)).text, /attachment_id or url/);
  });

  test("read_attachment reads text attachments of this chat only", async () => {
    const { saveUpload } = await import("@/lib/server/store");
    await saveUpload("brief7", "txt", new TextEncoder().encode("The brief."));
    const { ctx } = await setup({
      attachments: () => [
        { id: "brief7", name: "brief.txt", kind: "text" },
        { id: "img7", name: "photo.png", kind: "image" },
      ],
    });
    assert.equal((await runTool("read_attachment", { attachment_id: "brief7" }, ctx)).text, '<attachment name="brief.txt">\nThe brief.\n</attachment>');
    assert.match((await runTool("read_attachment", { attachment_id: "img7" }, ctx)).text, /an image/);
    assert.match((await runTool("read_attachment", { attachment_id: "other" }, ctx)).text, /No attachment other in this chat. Attachments: brief7/);
  });
});

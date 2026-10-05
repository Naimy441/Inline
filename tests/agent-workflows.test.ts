import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { Transform } from "prosemirror-transform";

import { docToMarkdown } from "@/lib/doc/markdown";
import { schema } from "@/lib/doc/schema";
import { readDocumentFile } from "@/lib/server/store";
import { LiveDocument, documentHub } from "@/lib/server/hub";

import { BrowserClient } from "./support/browser-client";
import { connectHttp, connectInProcess, useTempDataDir, type McpHarness } from "./support/mcp";

/**
 * Whole agent workflows, the way Claude actually works in Inline: several
 * tool calls in sequence over MCP, against documents the user has open in a
 * (headless) browser editor that keeps typing while Claude works.
 */

useTempDataDir("inline-workflows-");

const hub = documentHub();
let external: McpHarness;

before(async () => {
  external = await connectHttp();
});
after(() => external.close());

async function openInBrowser(markdown: string, title = "Doc") {
  const live = await hub.create({ title, markdown });
  hub.activeDocumentId = live.id;
  const browser = new BrowserClient(live);
  return { live, browser };
}

describe("drafting a document from a brief", () => {
  test("Claude drafts, formats and sets up a new document; the user keeps it; it persists", async () => {
    const { live, browser } = await openInBrowser("");
    const context = await external.call("get_editor_context");
    assert.match(context.text, /0 words/);

    const draft = `# Launch plan {.title}

Q4 rollout {.subtitle}

## Goals

- Ship the editor to 100 beta users
- Keep weekly churn under 5%

## Timeline

| Week | Milestone |
| --- | --- |
| 1 | Private beta |
| 4 | Public launch |

## Risks

Hiring may slip. We will **re-plan** in week 2.`;
    const written = await external.call("write_document", { content: draft });
    assert.equal(written.isError, false, written.text);

    await external.call("update_document_settings", { title: "Launch plan", font_family: "Georgia", page_numbers: { enabled: true } });
    await external.call("format_text", { text: "100 beta users", highlight: true });
    await external.call("set_paragraph_style", { from_line: 3, align: "center" });

    const outline = await external.call("get_outline");
    for (const heading of ["[title] Launch plan", "[subtitle] Q4 rollout", "## Goals", "## Timeline", "## Risks"]) assert.ok(outline.text.includes(heading), `${heading} missing:\n${outline.text}`);

    // The browser saw every change live.
    assert.equal(browser.markdown, docToMarkdown(live.doc));
    assert.ok(live.hunks.length > 0);
    assert.equal(browser.hunks.length, live.hunks.length);

    const kept = await external.call("keep_changes", { all: true });
    assert.equal(kept.isError, false, kept.text);
    assert.equal(live.hunks.length, 0);
    assert.equal(browser.hunks.length, 0);

    await live.flush();
    const file = await readDocumentFile(live.id);
    const reloaded = new LiveDocument(file!);
    assert.equal(docToMarkdown(reloaded.doc), docToMarkdown(live.doc));
    assert.equal(reloaded.meta.title, "Launch plan");
    assert.equal(reloaded.meta.settings.pageNumbers.enabled, true);
    assert.match(docToMarkdown(reloaded.doc), /==100 beta users==/);
    assert.match(docToMarkdown(reloaded.doc), /\| 4 \| Public launch \|/);
    browser.close();
  });
});

describe("revising while the user types", () => {
  test("Claude's edits and the user's typing interleave without losing either", async () => {
    const paragraphs = Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1} says something plain.`);
    const { live, browser } = await openInBrowser(paragraphs.join("\n\n"));

    for (let round = 0; round < 6; round += 1) {
      // The user types at the end of paragraph 1, but hasn't sent it yet...
      const at = browser.state.doc.firstChild!.nodeSize - 1;
      browser.type(at, ` u${round}`);
      // The browser's connection lags, so it hasn't seen Claude's earlier edits yet either.
      browser.pause();
      // ...when Claude's edit to a later paragraph lands.
      const edit = await external.call("edit_document", { old_string: `Paragraph ${round + 3} says something plain.`, new_string: `Paragraph ${round + 3} says something vivid.` });
      assert.equal(edit.isError, false, edit.text);
      browser.flush();
      assert.equal(browser.markdown, docToMarkdown(live.doc), `diverged in round ${round}`);
    }

    const text = docToMarkdown(live.doc);
    assert.match(text, /Paragraph 1 says something plain\. u0 u1 u2 u3 u4 u5/);
    for (let n = 3; n <= 8; n += 1) assert.match(text, new RegExp(`Paragraph ${n} says something vivid\\.`));
    assert.ok(browser.conflicts > 0, "the user's steps really were rebased over Claude's");

    // Undoing Claude's changes restores its paragraphs and keeps the user's typing.
    await external.call("revert_changes", { all: true });
    const reverted = docToMarkdown(live.doc);
    assert.match(reverted, /Paragraph 1 says something plain\. u0 u1 u2 u3 u4 u5/);
    assert.doesNotMatch(reverted, /vivid/);
    assert.equal(browser.markdown, reverted);
    browser.close();
  });

  test("the user editing the same sentence Claude just changed keeps the user's words", async () => {
    const { live, browser } = await openInBrowser("The meeting is on Monday at noon.");
    await external.call("edit_document", { old_string: "Monday", new_string: "Tuesday" });
    const at = browser.find("noon") + "noon".length;
    browser.type(at, " sharp");
    browser.flush();
    assert.equal(docToMarkdown(live.doc), "The meeting is on Tuesday at noon sharp.");
    await external.call("revert_changes", { all: true });
    assert.equal(docToMarkdown(live.doc), "The meeting is on Monday at noon sharp.");
    browser.close();
  });

  test("the user's selection is what Claude sees as \"this\"", async () => {
    const { browser } = await openInBrowser("First line.\n\nMake this sentence shorter please.\n\nLast line.");
    const from = browser.find("Make this sentence shorter please.");
    browser.select(from, from + "Make this sentence shorter please.".length);
    const context = await external.call("get_editor_context");
    assert.match(context.text, /Selection \(lines 3-3\):\n"""\nMake this sentence shorter please\.\n"""/);
    const edit = await external.call("edit_document", { old_string: "Make this sentence shorter please.", new_string: "Shorter." });
    assert.equal(edit.isError, false);
    assert.equal(browser.markdown, "First line.\n\nShorter.\n\nLast line.");
    browser.close();
  });
});

describe("working through review feedback", () => {
  test("Claude addresses the user's comments by editing and replying", async () => {
    const { live, browser } = await openInBrowser("Our revenue grew a lot last year.\n\nCosts were flat.");
    const from = browser.find("a lot");
    live.addComment({ from, to: from + "a lot".length, body: "Give a number.", author: "user" }, { kind: "client", clientID: browser.clientID });

    const comments = await external.call("list_comments");
    const id = comments.text.match(/\[(\S+)\] User on "a lot": Give a number\./)?.[1];
    assert.ok(id, comments.text);
    await external.call("edit_document", { old_string: "grew a lot", new_string: "grew 38%" });
    const reply = await external.call("reply_to_comment", { comment_id: id, reply: "Changed to 38% (from the Q4 report).", resolve: true });
    assert.equal(reply.isError, false, reply.text);

    assert.equal(live.comments[0]!.resolved, true);
    assert.deepEqual(
      live.comments[0]!.replies.map((r) => [r.author, r.body]),
      [["claude", "Changed to 38% (from the Q4 report)."]],
    );
    const all = await external.call("list_comments", { include_resolved: true });
    assert.match(all.text, /\(resolved\)/);
    assert.equal(browser.markdown, "Our revenue grew 38% last year.\n\nCosts were flat.");
    browser.close();
  });

  test("Claude reviews the user's suggestions: keeps one, undoes another, on request", async () => {
    const { live, browser } = await openInBrowser("Alpha beta gamma.\n\nDelta epsilon zeta.");
    // The user suggests two changes in suggesting mode.
    const beta = browser.find("beta");
    browser.replace(beta, beta + 4, "BETA");
    browser.flush({ suggest: true });
    const zeta = browser.find("zeta");
    browser.replace(zeta, zeta + 4, "ZETA");
    browser.flush({ suggest: true });
    assert.equal(live.hunks.length, 2);
    assert.ok(live.hunks.every((hunk) => hunk.author === "user"));

    const pending = await external.call("get_pending_changes");
    const ids = [...pending.text.matchAll(/- (\S+) \(line (\d+), suggested by the user\)/g)].map((match) => ({ id: match[1]!, line: Number(match[2]) }));
    assert.deepEqual(
      ids.map((entry) => entry.line),
      [1, 3],
    );
    await external.call("keep_changes", { change_ids: [ids[0]!.id] });
    await external.call("revert_changes", { change_ids: [ids[1]!.id] });
    assert.equal(docToMarkdown(live.doc), "Alpha BETA gamma.\n\nDelta epsilon zeta.");
    assert.equal(browser.markdown, docToMarkdown(live.doc));
    assert.equal(live.hunks.length, 0);
    browser.close();
  });
});

describe("recovering from mistakes", () => {
  test("a rewrite can be rolled back from the checkpoint the in-app agent takes", async () => {
    const original = "Keep this exact wording.\n\nAnd this.";
    const { live, browser } = await openInBrowser(original);
    const chat = await connectInProcess(() => ({
      author: "chat-undo",
      documentId: live.id,
      beforeWrite: async (doc) => {
        await doc.checkpoint("Before Claude's edits");
      },
    }));
    await chat.call("write_document", { content: "Completely different." });
    await chat.call("keep_changes", { all: true });
    assert.equal(docToMarkdown(live.doc), "Completely different.");

    const versions = await chat.call("list_versions");
    const id = versions.text.match(/^- (\S+): "Before Claude's edits"/m)?.[1];
    assert.ok(id, versions.text);
    await chat.call("restore_version", { version_id: id });
    assert.equal(docToMarkdown(live.doc), original);
    assert.equal(browser.markdown, original, "the browser follows the restore");
    await chat.close();
    browser.close();
  });

  test("locked passages survive every kind of write", async () => {
    const { live } = await openInBrowser("Legal: do not change this clause.\n\nFree text here.");
    const from = docToMarkdown(live.doc).indexOf("do not change") >= 0 ? findPos(live, "do not change this clause.") : -1;
    live.applyTransform(new Transform(live.doc).addMark(from, from + "do not change this clause.".length, schema.mark("locked", { id: "l1" })), { kind: "system", label: "lock" });
    const attempts = [
      external.call("edit_document", { old_string: "do not change", new_string: "feel free to change" }),
      external.call("multi_edit_document", { edits: [{ old_string: "Free text", new_string: "Open text" }, { old_string: "this clause", new_string: "that clause" }] }),
      external.call("write_document", { content: "Legal: whatever.\n\nFree text here." }),
      external.call("format_text", { text: "this clause", bold: true }),
    ];
    for (const result of await Promise.all(attempts)) {
      assert.equal(result.isError, true);
      assert.match(result.text, /locked/);
    }
    assert.equal(docToMarkdown(live.doc), "Legal: do not change this clause.\n\nFree text here.");
    const allowed = await external.call("edit_document", { old_string: "Free text here.", new_string: "Edited freely." });
    assert.equal(allowed.isError, false, allowed.text);
  });
});

describe("several agents at once", () => {
  test("the in-app chat and two external clients edit concurrently; each change is attributed and reviewable", async () => {
    const { live, browser } = await openInBrowser("One.\n\nTwo.\n\nThree.\n\nFour.");
    const chat = await connectInProcess(() => ({ author: "chat-a", documentId: live.id }));
    const second = await connectHttp();
    const results = await Promise.all([
      chat.call("edit_document", { old_string: "One.", new_string: "One, by the chat." }),
      external.call("edit_document", { old_string: "Two.", new_string: "Two, from outside.", document_id: live.id }),
      second.call("edit_document", { old_string: "Three.", new_string: "Three, from a second client.", document_id: live.id }),
    ]);
    for (const result of results) assert.equal(result.isError, false, result.text);
    assert.equal(docToMarkdown(live.doc), "One, by the chat.\n\nTwo, from outside.\n\nThree, from a second client.\n\nFour.");
    assert.deepEqual(live.hunks.map((hunk) => hunk.author).sort(), ["chat-a", "external", "external"]);
    assert.equal(browser.markdown, docToMarkdown(live.doc));

    const chatHunk = live.hunks.find((hunk) => hunk.author === "chat-a")!;
    await chat.call("revert_changes", { change_ids: [chatHunk.id] });
    assert.equal(docToMarkdown(live.doc), "One.\n\nTwo, from outside.\n\nThree, from a second client.\n\nFour.");
    await chat.close();
    await second.close();
    browser.close();
  });

  test("working across documents by id", async () => {
    const { live: notes } = await openInBrowser("Raw notes: buy milk, call Sam.", "Notes");
    const created = await external.call("create_document", { title: "Tasks", content: "# Tasks {.title}" });
    const tasksId = created.text.match(/\(id (\S+)\)/)![1]!;
    const read = await external.call("read_document", { document_id: notes.id });
    assert.match(read.text, /buy milk/);
    await external.call("insert_content", { document_id: tasksId, content: "- [ ] Buy milk\n- [ ] Call Sam", position: "end" });
    await external.call("edit_document", { document_id: notes.id, old_string: "Raw notes: buy milk, call Sam.", new_string: "Moved to Tasks." });
    const tasks = (await hub.require(tasksId)).doc;
    assert.equal(docToMarkdown(tasks), "# Tasks {.title}\n\n- [ ] Buy milk\n- [ ] Call Sam");
    assert.equal(docToMarkdown(notes.doc), "Moved to Tasks.");
  });
});

describe("long documents", () => {
  test("reading in pages, searching and editing near the end stay fast", async () => {
    const sections = Array.from({ length: 60 }, (_, s) => [`## Section ${s + 1}`, ...Array.from({ length: 5 }, (_, p) => `Section ${s + 1} paragraph ${p + 1} has some ordinary words in it.`)].join("\n\n"));
    const { live, browser } = await openInBrowser(sections.join("\n\n"));
    const start = performance.now();

    const outline = await external.call("get_outline");
    assert.match(outline.text, /## Section 60 — /);
    const page = await external.call("read_document", { offset: 701, limit: 10 });
    assert.match(page.text, /Showing lines 701-710 of 719\./);
    const search = await external.call("search_document", { pattern: "Section 59 paragraph 3" });
    assert.match(search.text, /^1 matching line/);
    const edit = await external.call("edit_document", { old_string: "Section 59 paragraph 3 has some ordinary words in it.", new_string: "Section 59 paragraph 3 now has extraordinary words." });
    assert.equal(edit.isError, false, edit.text);
    const pending = await external.call("get_pending_changes");
    const line = Number(pending.text.match(/\(line (\d+), by Claude\)/)![1]);
    const lineText = (await external.call("read_document", { offset: line, limit: 1 })).text;
    assert.match(lineText, /extraordinary/, "the reported line is the edited one");

    const elapsed = performance.now() - start;
    assert.ok(elapsed < 5000, `took ${Math.round(elapsed)}ms`);
    assert.equal(browser.markdown, docToMarkdown(live.doc));
    browser.close();
  });
});

describe("formatting Markdown can't show survives Claude's edits", () => {
  test("colors and fonts stay on unchanged words through edit and write", async () => {
    const { live } = await openInBrowser("Brand name stays red. The rest is plain.");
    const from = findPos(live, "Brand name");
    const tr = new Transform(live.doc)
      .addMark(from, from + "Brand name".length, schema.mark("text_color", { color: "#c5221f" }))
      .addMark(from, from + "Brand name".length, schema.mark("font_family", { family: "Georgia, serif" }));
    live.applyTransform(tr, { kind: "client", clientID: "browser" });

    await external.call("edit_document", { old_string: "The rest is plain.", new_string: "Everything else is plain." });
    await external.call("write_document", { content: "Brand name stays red. Everything else is plain, and short." });
    let styled = "";
    live.doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === "text_color") && node.marks.some((mark) => mark.type.name === "font_family")) styled += node.text;
    });
    assert.equal(styled, "Brand name");
  });
});

function findPos(live: LiveDocument, text: string) {
  let found = -1;
  live.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text!.includes(text)) found = pos + node.text!.indexOf(text);
    return true;
  });
  assert.ok(found >= 0, `"${text}" not found`);
  return found;
}

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Fragment, Slice } from "prosemirror-model";
import { ReplaceStep, Transform } from "prosemirror-transform";
import { docToMarkdown } from "@/lib/doc/markdown";
import { schema } from "@/lib/doc/schema";
import { documentHub, StepConflictError, type HubEvent, type LiveDocument } from "@/lib/server/hub";

process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-hub-"));

const hub = documentHub();

function textPos(doc: LiveDocument, text: string) {
  let found = -1;
  doc.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text!.includes(text)) found = pos + node.text!.indexOf(text);
    return found < 0;
  });
  assert.ok(found >= 0, `"${text}" is in the document`);
  return found;
}

function insertStep(pos: number, text: string) {
  return new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0)).toJSON();
}

function record(doc: LiveDocument) {
  const events: HubEvent[] = [];
  const stop = doc.subscribe((event) => events.push(event));
  return { events, stop };
}

describe("creating and listing documents", () => {
  it("creates from Markdown with clean defaults", async () => {
    const doc = await hub.create({ title: "Notes", markdown: "# Notes\n\nFirst line." });
    assert.equal(doc.meta.title, "Notes");
    assert.equal(doc.meta.autoTitle, false);
    assert.equal(doc.version, 0);
    assert.match(docToMarkdown(doc.doc), /First line\./);
    assert.equal(doc.meta.wordCount, 3);
  });

  it("lists newest first and keeps trashed documents separate", async () => {
    const a = await hub.create({ title: "Older" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await hub.create({ title: "Newer" });
    a.setTrashed(true);
    const live = await hub.list();
    const trashed = await hub.list({ trashed: true });
    assert.ok(live.findIndex((meta) => meta.id === b.id) >= 0);
    assert.equal(live.find((meta) => meta.id === a.id), undefined);
    assert.ok(trashed.some((meta) => meta.id === a.id));
    await assert.rejects(hub.require(a.id), /not found/);
  });

  it("duplicates the content and settings under a new id", async () => {
    const source = await hub.create({ title: "Source", markdown: "Body text", settings: { fontSize: 14 } });
    const copy = await hub.duplicate(source.id);
    assert.notEqual(copy.id, source.id);
    assert.equal(copy.meta.title, "Source (copy)");
    assert.equal(copy.meta.settings.fontSize, 14);
    assert.equal(copy.doc.textContent, source.doc.textContent);
  });

  it("removes a document and tells open editors", async () => {
    const doc = await hub.create({ title: "Doomed" });
    const { events } = record(doc);
    await hub.remove(doc.id);
    assert.ok(events.some((event) => event.type === "deleted"));
    assert.equal(await hub.get(doc.id), null);
  });

  it("reloads a saved document from disk", async () => {
    const doc = await hub.create({ title: "Persisted", markdown: "Saved words" });
    await doc.flush();
    const file = doc.toFile();
    assert.equal(file.format, 3);
    assert.equal(file.meta.title, "Persisted");
  });
});

describe("collaboration (prosemirror-collab)", () => {
  it("applies steps based on the current version and broadcasts them", async () => {
    const doc = await hub.create({ markdown: "Hello" });
    const { events } = record(doc);
    const version = doc.receiveClientSteps(0, [insertStep(textPos(doc, "Hello") + 5, " world")], "tab-1");
    assert.equal(version, 1);
    assert.equal(doc.doc.textContent, "Hello world");
    const steps = events.find((event) => event.type === "steps");
    assert.ok(steps && steps.type === "steps" && steps.clientIDs[0] === "tab-1");
  });

  it("rejects steps based on an old version with the version to catch up to", async () => {
    const doc = await hub.create({ markdown: "Hello" });
    doc.receiveClientSteps(0, [insertStep(1, "A")], "tab-1");
    assert.throws(() => doc.receiveClientSteps(0, [insertStep(1, "B")], "tab-2"), (error: unknown) => error instanceof StepConflictError && error.version === 1);
  });

  it("serves the steps a reconnecting editor missed", async () => {
    const doc = await hub.create({ markdown: "Hello" });
    doc.receiveClientSteps(0, [insertStep(1, "A")], "tab-1");
    doc.receiveClientSteps(1, [insertStep(1, "B")], "tab-1");
    const missed = doc.stepsSince(1);
    assert.equal(missed?.steps.length, 1);
    assert.equal(doc.stepsSince(5), null, "a future version can't be served");
  });

  it("refuses a step that doesn't fit the document", async () => {
    const doc = await hub.create({ markdown: "Hi" });
    assert.throws(() => doc.receiveClientSteps(0, [insertStep(999, "x")], "tab-1"));
    assert.equal(doc.version, 0);
  });

  it("rejects server transforms that are not based on the current document", async () => {
    const doc = await hub.create({ markdown: "Hello" });
    const stale = new Transform(doc.doc).insert(1, schema.text("X"));
    doc.receiveClientSteps(0, [insertStep(1, "A")], "tab-1");
    assert.throws(() => doc.applyTransform(stale, { kind: "system", label: "test" }), /not based on the current document/);
  });
});

describe("review", () => {
  it("records agent edits as hunks and undoes them", async () => {
    const doc = await hub.create({ markdown: "The lazy dog." });
    const from = textPos(doc, "lazy");
    doc.applyTransform(new Transform(doc.doc).replaceWith(from, from + 4, schema.text("sleepy")), { kind: "agent", author: "chat-1" });
    assert.equal(doc.hunks.length, 1);
    doc.review("reject", "all");
    assert.equal(doc.doc.textContent, "The lazy dog.");
    assert.equal(doc.hunks.length, 0);
  });

  it("keeping a hunk leaves the text and clears the review", async () => {
    const doc = await hub.create({ markdown: "The lazy dog." });
    const from = textPos(doc, "lazy");
    doc.applyTransform(new Transform(doc.doc).replaceWith(from, from + 4, schema.text("sleepy")), { kind: "agent", author: "chat-1" });
    const [hunk] = doc.hunks;
    doc.review("accept", [hunk!.id]);
    assert.equal(doc.doc.textContent, "The sleepy dog.");
    assert.equal(doc.hunks.length, 0);
  });

  it("maps pending hunks through the user's typing elsewhere", async () => {
    const doc = await hub.create({ markdown: "Alpha beta gamma." });
    const from = textPos(doc, "gamma");
    doc.applyTransform(new Transform(doc.doc).replaceWith(from, from + 5, schema.text("delta")), { kind: "agent", author: "chat-1" });
    doc.receiveClientSteps(doc.version, [insertStep(1, "Very ")], "tab-1");
    doc.review("reject", "all");
    assert.equal(doc.doc.textContent, "Very Alpha beta gamma.");
  });
});

describe("metadata and titles", () => {
  it("renaming stops the title from following the first line", async () => {
    const doc = await hub.create({});
    assert.equal(doc.meta.autoTitle, true);
    doc.updateMeta({ title: "  Chosen   name " });
    assert.equal(doc.meta.title, "Chosen name");
    assert.equal(doc.meta.autoTitle, false);
  });

  it("an untitled document takes its title from its first line when saved", async () => {
    const doc = await hub.create({});
    doc.receiveClientSteps(0, [insertStep(1, "Trip to Lisbon")], "tab-1");
    await doc.flush();
    assert.equal(doc.meta.title, "Trip to Lisbon");
    assert.equal(doc.meta.wordCount, 3);
    assert.equal(doc.meta.preview, "Trip to Lisbon");
  });

  it("patches settings and broadcasts the new meta", async () => {
    const doc = await hub.create({});
    const { events } = record(doc);
    doc.updateMeta({ settings: { pageSetup: { orientation: "landscape" } } });
    assert.equal(doc.meta.settings.pageSetup.orientation, "landscape");
    assert.ok(events.some((event) => event.type === "meta"));
  });

  it("ignores a selection reported for a stale version and clamps the rest", async () => {
    const doc = await hub.create({ markdown: "Short" });
    doc.setSelection({ from: 1, to: 3, version: 7 });
    assert.equal(doc.selection as unknown, null);
    doc.setSelection({ from: 2, to: 9999, version: 0 });
    assert.equal(doc.selection!.to, doc.doc.content.size);
  });
});

describe("comments", () => {
  it("anchors a comment to a range and follows the text", async () => {
    const doc = await hub.create({ markdown: "Check this claim please." });
    const from = textPos(doc, "this claim");
    const comment = doc.addComment({ from, to: from + 10, body: " Source? ", author: "user" }, { kind: "client", clientID: "tab" });
    assert.equal(comment.quote, "this claim");
    assert.equal(comment.body, "Source?");
    assert.equal(doc.hunks.length, 0, "a comment is not a reviewable change");
    doc.receiveClientSteps(doc.version, [insertStep(1, "Please ")], "tab");
    assert.equal(doc.commentsWithAnchors()[0]!.anchor?.text, "this claim");
  });

  it("supports replies, resolving, editing and deleting", async () => {
    const doc = await hub.create({ markdown: "Some words here." });
    const from = textPos(doc, "words");
    const comment = doc.addComment({ from, to: from + 5, body: "Vague", author: "user" }, { kind: "client", clientID: "tab" });
    doc.replyToComment(comment.id, "Fixed it", "claude");
    doc.setCommentResolved(comment.id, true);
    doc.editComment(comment.id, "Too vague");
    let [stored] = doc.commentsWithAnchors();
    assert.equal(stored!.replies[0]!.author, "claude");
    assert.equal(stored!.resolved, true);
    assert.equal(stored!.body, "Too vague");
    doc.deleteComment(comment.id);
    [stored] = doc.commentsWithAnchors();
    assert.equal(stored, undefined);
    let marked = false;
    doc.doc.descendants((node) => {
      if (node.marks.some((mark) => mark.type.name === "comment")) marked = true;
      return true;
    });
    assert.equal(marked, false, "the anchor mark is removed too");
    assert.throws(() => doc.replyToComment("missing", "x", "user"), /No comment/);
  });
});

describe("versions", () => {
  it("saves, lists and restores versions, checkpointing first", async () => {
    const doc = await hub.create({ markdown: "Version one." });
    const saved = await doc.saveVersion("First draft", "user");
    doc.receiveClientSteps(0, [insertStep(textPos(doc, "one"), "number ")], "tab");
    assert.equal(doc.doc.textContent, "Version number one.");
    await doc.restoreVersion(saved.id);
    assert.equal(doc.doc.textContent, "Version one.");
    const labels = (await doc.versions()).map((version) => version.label);
    assert.ok(labels.includes("First draft"));
    assert.ok(labels.includes("Before restoring a version"));
    await assert.rejects(doc.restoreVersion("nope"), /not found/i);
  });
});

describe("commands and activity", () => {
  it("reports how many editors received a command", async () => {
    const doc = await hub.create({});
    assert.equal(doc.sendCommand({ kind: "print" }), 0);
    const { stop } = record(doc);
    assert.equal(doc.sendCommand({ kind: "export_pdf" }), 1);
    stop();
  });

  it("stamps agent activity with the current version", async () => {
    const doc = await hub.create({ markdown: "x" });
    const { events } = record(doc);
    doc.setActivity({ chatId: "c", status: "editing", label: "Editing" });
    assert.equal(doc.activity?.version, 0);
    assert.ok(events.some((event) => event.type === "activity"));
  });
});

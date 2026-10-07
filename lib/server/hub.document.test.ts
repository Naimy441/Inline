import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { Slice, type Node as PMNode } from "prosemirror-model";
import { Step, Transform } from "prosemirror-transform";

import { applyStringEdits, docPlainText, findText } from "@/lib/doc/editing";
import { ensureBlockIds } from "@/lib/doc/ids";
import { markdownToDoc } from "@/lib/doc/markdown";
import { hunkToJSON, type Hunk } from "@/lib/doc/review";
import { schema } from "@/lib/doc/schema";
import { DEFAULT_SETTINGS, type DocumentMeta } from "@/lib/doc/settings";
import { LiveDocument, StaleEpochError, StepConflictError, documentHub, loadDoc, type HubEvent } from "@/lib/server/hub";
import { dataDir, readDocumentFile, type StoredDocumentFile } from "@/lib/server/store";

// The store resolves its directory on every call, so this applies before any write.
process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-hub-"));

const SAMPLE = "The quick brown fox jumps over the lazy dog.\n\nA second paragraph stays put.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Forget every open document, as a server restart would. */
function freshHub() {
  (globalThis as unknown as { __inlineHub?: unknown }).__inlineHub = undefined;
  return documentHub();
}

let seq = 0;
function meta(overrides: Partial<DocumentMeta> = {}): DocumentMeta {
  const now = Date.now();
  seq += 1;
  return {
    id: `live${seq}${now.toString(36)}`,
    title: "Test",
    autoTitle: false,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    trashedAt: null,
    settings: DEFAULT_SETTINGS,
    wordCount: 0,
    preview: "",
    ...overrides,
  };
}

function makeLive(markdown = SAMPLE, file: Partial<StoredDocumentFile> = {}) {
  const doc = ensureBlockIds(markdownToDoc(markdown));
  return new LiveDocument({ format: 3, meta: meta(), doc: doc.toJSON(), comments: [], hunks: [], ...file });
}

function range(doc: PMNode, text: string) {
  const [hit] = findText(doc, text);
  assert.ok(hit, `"${text}" not found`);
  return hit;
}

function textOf(doc: PMNode) {
  return docPlainText(doc);
}

/** Steps a browser editor would send to insert `text` at `pos`. */
function insertSteps(doc: PMNode, pos: number, text: string) {
  const tr = new Transform(doc).insert(pos, schema.text(text));
  return tr.steps.map((step) => step.toJSON());
}

function deleteSteps(doc: PMNode, from: number, to: number) {
  return new Transform(doc).delete(from, to).steps.map((step) => step.toJSON());
}

function agentEdit(live: LiveDocument, old_string: string, new_string: string, author = "chat-1") {
  const tr = applyStringEdits(live.doc, [{ old_string, new_string }]);
  return live.applyTransform(tr, { kind: "agent", author });
}

function record(live: LiveDocument) {
  const events: HubEvent[] = [];
  const off = live.subscribe((event) => events.push(event));
  return { events, off, of: <T extends HubEvent["type"]>(type: T) => events.filter((e): e is Extract<HubEvent, { type: T }> => e.type === type) };
}

function hunkTexts(live: LiveDocument) {
  return live.hunks.map((hunk) => ({
    inserted: live.doc.textBetween(hunk.from, hunk.to, "\n"),
    deleted: hunk.deleted.content.textBetween(0, hunk.deleted.content.size, "\n"),
  }));
}

// ---------------------------------------------------------------------------

describe("DocumentHub lifecycle", () => {
  it("create builds a document from Markdown, persists it and get returns the same instance", async () => {
    const hub = documentHub();
    const live = await hub.create({ title: "Notes", markdown: SAMPLE });
    assert.equal(live.meta.title, "Notes");
    assert.equal(live.meta.autoTitle, false);
    assert.equal(live.meta.trashedAt, null);
    assert.equal(live.meta.wordCount, 14);
    assert.match(textOf(live.doc), /quick brown fox/);
    assert.equal(await hub.get(live.id), live);
    const file = await readDocumentFile(live.id);
    assert.ok(file);
    assert.equal(file.meta.id, live.id);
    // Every top-level block has a unique id.
    const ids = new Set<string>();
    live.doc.forEach((node) => ids.add(node.attrs.id as string));
    assert.equal(ids.size, live.doc.childCount);
    assert.ok(![...ids].includes(null as unknown as string));
  });

  it("create with no title (or an 'Untitled' one) follows the first line", async () => {
    const hub = documentHub();
    const a = await hub.create({});
    assert.equal(a.meta.title, "Untitled document");
    assert.equal(a.meta.autoTitle, true);
    assert.equal(a.doc.childCount, 1);
    const b = await hub.create({ title: "untitled 3" });
    assert.equal(b.meta.autoTitle, true);
  });

  it("create accepts ProseMirror JSON and falls back to an empty doc for garbage", async () => {
    const hub = documentHub();
    const source = ensureBlockIds(markdownToDoc("# Heading\n\nBody"));
    const a = await hub.create({ doc: source.toJSON() });
    assert.ok(a.doc.eq(source));
    const b = await hub.create({ doc: { type: "nonsense" } });
    assert.equal(b.doc.childCount, 1);
    assert.equal(b.doc.textContent, "");
  });

  it("get returns null for unknown and unsafe ids; require throws", async () => {
    const hub = documentHub();
    assert.equal(await hub.get("does-not-exist"), null);
    assert.equal(await hub.get("../etc/passwd"), null);
    await assert.rejects(hub.require("does-not-exist"), /was not found/);
  });

  it("concurrent gets of an unopened document load it once", async () => {
    const created = await documentHub().create({ markdown: "Hello" });
    await created.flush();
    const hub = freshHub();
    const [a, b, c] = await Promise.all([hub.get(created.id), hub.get(created.id), hub.get(created.id)]);
    assert.ok(a);
    assert.equal(a, b);
    assert.equal(b, c);
  });

  it("list includes open and on-disk documents, hides trashed ones, and require rejects trashed", async () => {
    const hub = documentHub();
    const kept = await hub.create({ title: "Kept" });
    const binned = await hub.create({ title: "Binned" });
    binned.setTrashed(true);
    const visible = await hub.list();
    assert.ok(visible.some((m) => m.id === kept.id));
    assert.ok(!visible.some((m) => m.id === binned.id));
    const trashed = await hub.list({ trashed: true });
    assert.ok(trashed.some((m) => m.id === binned.id));
    assert.ok(!trashed.some((m) => m.id === kept.id));
    await assert.rejects(hub.require(binned.id), /was not found/);
    // get still returns trashed documents (so they can be restored).
    assert.equal(await hub.get(binned.id), binned);
    binned.setTrashed(false);
    assert.equal(await hub.require(binned.id), binned);
  });

  it("list is sorted most recently opened or updated first", async () => {
    const hub = documentHub();
    const older = await hub.create({ title: "Older" });
    await sleep(5);
    const newer = await hub.create({ title: "Newer" });
    let ids = (await hub.list()).map((m) => m.id);
    assert.ok(ids.indexOf(newer.id) < ids.indexOf(older.id));
    await sleep(5);
    older.touch();
    ids = (await hub.list()).map((m) => m.id);
    assert.equal(ids[0], older.id);
  });

  it("duplicate copies content and settings under a new id", async () => {
    const hub = documentHub();
    const source = await hub.create({ title: "Report", markdown: SAMPLE, settings: { ...DEFAULT_SETTINGS, fontSize: 14 } });
    const copy = await hub.duplicate(source.id);
    assert.notEqual(copy.id, source.id);
    assert.equal(copy.meta.title, "Report (copy)");
    assert.equal(textOf(copy.doc), textOf(source.doc));
    assert.deepEqual(copy.meta.settings, source.meta.settings);
    // Editing the copy leaves the source alone.
    agentEdit(copy, "lazy", "sleepy");
    assert.match(textOf(source.doc), /lazy dog/);
    source.setTrashed(true);
    await assert.rejects(hub.duplicate(source.id), /was not found/);
  });

  it("remove deletes the file, notifies subscribers and clears the active document", async () => {
    const hub = documentHub();
    const live = await hub.create({ markdown: "Bye" });
    await live.saveVersion("v", "user");
    hub.activeDocumentId = live.id;
    const { events } = record(live);
    await hub.remove(live.id);
    assert.deepEqual(events.map((e) => e.type), ["deleted"]);
    assert.equal(live.subscriberCount, 0);
    assert.equal(hub.activeDocumentId, null);
    assert.equal(await hub.get(live.id), null);
    assert.equal(existsSync(path.join(dataDir(), "documents", `${live.id}.json`)), false);
    assert.equal(existsSync(path.join(dataDir(), "versions", live.id)), false);
    assert.equal((await hub.list()).some((m) => m.id === live.id), false);
  });

  it("active() returns the focused document, else the most recent non-trashed one", async () => {
    const hub = documentHub();
    const focused = await hub.create({ title: "Focused" });
    await sleep(5);
    const latest = await hub.create({ title: "Latest" });
    hub.activeDocumentId = focused.id;
    assert.equal(await hub.active(), focused);
    focused.setTrashed(true);
    assert.equal(await hub.active(), latest);
    hub.activeDocumentId = "gone-for-good";
    assert.equal(await hub.active(), latest);
    hub.activeDocumentId = null;
    assert.equal(await hub.active(), latest);
  });
});

// ---------------------------------------------------------------------------

describe("collab steps", () => {
  it("applies client steps, bumps the version and emits steps with client ids", () => {
    const live = makeLive();
    const { events } = record(live);
    const steps = insertSteps(live.doc, 1, "Hey! ");
    const version = live.receiveClientSteps(0, steps, "client-a");
    assert.equal(version, 1);
    assert.equal(live.version, 1);
    assert.match(textOf(live.doc), /^Hey! The quick/);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.type, "steps");
    if (event.type !== "steps") return;
    assert.equal(event.version, 1);
    assert.deepEqual(event.clientIDs, ["client-a"]);
    assert.deepEqual(event.steps, steps);
    // No hunks were involved, so none are broadcast.
    assert.equal("hunks" in event, false);
  });

  it("rejects steps based on a stale version with the current version", () => {
    const live = makeLive();
    live.receiveClientSteps(0, insertSteps(live.doc, 1, "A"), "a");
    const before = live.doc;
    assert.throws(
      () => live.receiveClientSteps(0, insertSteps(before, 1, "B"), "b"),
      (error: unknown) => error instanceof StepConflictError && error.version === 1,
    );
    assert.throws(() => live.receiveClientSteps(5, [], "b"), StepConflictError);
    assert.equal(live.doc, before);
    assert.equal(live.version, 1);
  });

  it("an invalid step rejects the whole batch and leaves the document untouched", () => {
    const live = makeLive();
    const before = live.doc;
    const { events } = record(live);
    const good = insertSteps(live.doc, 1, "ok ");
    // A paragraph cannot go inside a paragraph's inline content.
    const invalidStructure = { stepType: "replace", from: 3, to: 3, slice: { content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] } };
    assert.throws(() => live.receiveClientSteps(0, [...good, invalidStructure], "c"), /Step rejected/);
    assert.throws(() => live.receiveClientSteps(0, [...good, { stepType: "replace", from: 9999, to: 9999 }], "c"));
    assert.throws(() => live.receiveClientSteps(0, [{ stepType: "no-such-step" }], "c"));
    assert.equal(live.doc, before);
    assert.equal(live.version, 0);
    assert.equal(events.length, 0);
    assert.deepEqual(live.stepsSince(0), { steps: [], clientIDs: [] });
  });

  it("stepsSince returns the log tail and null outside the log", () => {
    const live = makeLive();
    live.receiveClientSteps(0, insertSteps(live.doc, 1, "1"), "a");
    live.receiveClientSteps(1, insertSteps(live.doc, 1, "2"), "b");
    agentEdit(live, "lazy", "sleepy", "chat-9");
    const all = live.stepsSince(0);
    assert.ok(all);
    assert.equal(all.steps.length, live.version);
    assert.deepEqual(all.clientIDs.slice(0, 2), ["a", "b"]);
    assert.ok(all.clientIDs.slice(2).every((id) => id === "agent:chat-9"));
    assert.deepEqual(live.stepsSince(live.version), { steps: [], clientIDs: [] });
    assert.equal(live.stepsSince(live.version + 1), null);
    assert.equal(live.stepsSince(-1), null);
    assert.deepEqual(live.stepsSince(1)!.clientIDs[0], "b");
  });

  it("replaying stepsSince(0) on the original document reproduces the current one", () => {
    const live = makeLive();
    const original = live.doc;
    live.receiveClientSteps(0, insertSteps(live.doc, 1, "Intro: "), "a");
    agentEdit(live, "brown fox", "red panda");
    const r = range(live.doc, "second");
    live.receiveClientSteps(live.version, deleteSteps(live.doc, r.from, r.to), "b");
    live.review("reject", "all");
    let doc = original;
    for (const json of live.stepsSince(0)!.steps) {
      const result = Step.fromJSON(schema, json).apply(doc);
      assert.equal(result.failed, null);
      doc = result.doc!;
    }
    assert.ok(doc.eq(live.doc));
  });

  it("truncates the step log beyond 2000 steps", () => {
    const live = makeLive("x");
    for (let i = 0; i < 2005; i += 1) live.receiveClientSteps(live.version, insertSteps(live.doc, 1, "a"), "typist");
    assert.equal(live.version, 2005);
    assert.equal(live.stepsSince(0), null);
    assert.equal(live.stepsSince(4), null);
    assert.equal(live.stepsSince(5)!.steps.length, 2000);
    assert.equal(live.stepsSince(2004)!.steps.length, 1);
  });

  it("subscribers can unsubscribe, and a throwing listener does not block the others", () => {
    const live = makeLive();
    const seen: string[] = [];
    live.subscribe(() => {
      throw new Error("boom");
    });
    const off = live.subscribe((e) => seen.push(`first:${e.type}`));
    live.subscribe((e) => seen.push(`second:${e.type}`));
    assert.equal(live.subscriberCount, 3);
    live.setActivity({ chatId: "c", status: "thinking", label: "Thinking" });
    off();
    live.setActivity(null);
    assert.deepEqual(seen, ["first:activity", "second:activity", "second:activity"]);
    assert.equal(live.subscriberCount, 2);
  });

  it("emits meta, activity, command and comments events", () => {
    const live = makeLive();
    const { events, of } = record(live);
    live.receiveClientSteps(0, insertSteps(live.doc, 1, "Hi "), "a");
    live.updateMeta({ title: "  New   name " });
    assert.equal(of("meta")[0]!.meta.title, "New name");
    assert.equal(live.meta.autoTitle, false);
    live.setActivity({ chatId: "chat", status: "editing", label: "Editing", range: { from: 1, to: 3 } });
    const activity = of("activity")[0]!.activity!;
    assert.equal(activity.version, 1);
    assert.equal(typeof activity.at, "number");
    assert.deepEqual(live.snapshot().activity, activity);
    assert.equal(live.sendCommand({ kind: "print" }), 1);
    assert.deepEqual(of("command")[0]!.command, { kind: "print" });
    live.addComment({ from: 1, to: 3, body: "note", author: "user" }, { kind: "client", clientID: "a" });
    assert.equal(of("comments").length, 1);
    live.setTrashed(true);
    assert.ok(of("meta")[1]!.meta.trashedAt);
    assert.deepEqual(
      events.map((e) => e.type),
      ["steps", "meta", "activity", "command", "steps", "comments", "meta"],
    );
  });

  it("updateMeta patches settings without dropping others", () => {
    const live = makeLive();
    const before = live.meta.settings;
    live.updateMeta({ settings: { fontSize: 15 } });
    assert.equal(live.meta.settings.fontSize, 15);
    assert.equal(live.meta.settings.fontFamily, before.fontFamily);
    assert.equal(live.meta.title, "Test");
  });
});

// ---------------------------------------------------------------------------

describe("server transforms", () => {
  it("agent transforms record hunks with the author and broadcast them", () => {
    const live = makeLive();
    const { of } = record(live);
    assert.equal(agentEdit(live, "lazy dog", "sleepy cat", "chat-42"), true);
    assert.equal(live.hunks.length, 1);
    assert.equal(live.hunks[0]!.author, "chat-42");
    assert.deepEqual(hunkTexts(live), [{ inserted: "sleepy cat", deleted: "lazy dog" }]);
    const event = of("steps")[0]!;
    assert.ok(event.clientIDs.every((id) => id === "agent:chat-42"));
    assert.equal(event.hunks!.length, 1);
    assert.equal(event.hunks![0]!.insertedText, "sleepy cat");
    assert.equal(event.hunks![0]!.deletedText, "lazy dog");
  });

  it("a no-op transform changes nothing and returns false", () => {
    const live = makeLive();
    const { events } = record(live);
    assert.equal(live.applyTransform(new Transform(live.doc), { kind: "agent", author: "x" }), false);
    assert.equal(live.version, 0);
    assert.equal(events.length, 0);
  });

  it("system transforms map existing hunks instead of recording new ones", () => {
    const live = makeLive();
    agentEdit(live, "lazy", "sleepy");
    const tr = new Transform(live.doc).insert(1, schema.text("Note: "));
    live.applyTransform(tr, { kind: "system", label: "test" });
    assert.equal(live.hunks.length, 1);
    assert.deepEqual(hunkTexts(live), [{ inserted: "sleepy", deleted: "lazy" }]);
    assert.equal(live.stepsSince(live.version - 1)!.clientIDs[0], "system:test");
  });

  it("rejects transforms not based on the current document", () => {
    const live = makeLive();
    const stale = new Transform(live.doc).insert(1, schema.text("stale "));
    live.receiveClientSteps(0, insertSteps(live.doc, 1, "fresh "), "a");
    assert.throws(() => live.applyTransform(stale, { kind: "agent", author: "x" }), /not based on the current document/);
    assert.doesNotMatch(textOf(live.doc), /stale/);
    // A structurally equal document (e.g. re-parsed) is accepted.
    const equal = loadDoc(live.doc.toJSON());
    assert.notEqual(equal, live.doc);
    assert.equal(live.applyTransform(new Transform(equal).insert(1, schema.text("ok ")), { kind: "system", label: "s" }), true);
  });

  it("gives new blocks inserted without ids a unique id", () => {
    const live = makeLive();
    const copy = live.doc.firstChild!; // same id as the first block
    const tr = new Transform(live.doc).insert(live.doc.content.size, [schema.node("paragraph"), copy]);
    live.applyTransform(tr, { kind: "system", label: "paste" });
    const ids: unknown[] = [];
    live.doc.forEach((node) => ids.push(node.attrs.id));
    assert.equal(ids.length, 4);
    assert.ok(ids.every((id) => typeof id === "string" && id.length > 0));
    assert.equal(new Set(ids).size, 4);
  });

  it("client edits map hunks; suggesting-mode edits are recorded as user suggestions", () => {
    const live = makeLive();
    agentEdit(live, "lazy", "sleepy");
    live.receiveClientSteps(live.version, insertSteps(live.doc, 1, "So, "), "a");
    assert.deepEqual(hunkTexts(live), [{ inserted: "sleepy", deleted: "lazy" }]);
    const r = range(live.doc, "second");
    const tr = new Transform(live.doc).replaceWith(r.from, r.to, schema.text("third"));
    live.receiveClientSteps(live.version, tr.steps.map((s) => s.toJSON()), "a", { suggest: true });
    assert.equal(live.hunks.length, 2);
    const suggestion = live.hunks.find((h) => h.author === "user");
    assert.ok(suggestion);
    assert.equal(live.doc.textBetween(suggestion.from, suggestion.to), "third");
    assert.equal(suggestion.deleted.content.textBetween(0, suggestion.deleted.content.size), "second");
    live.review("reject", [suggestion.id]);
    assert.match(textOf(live.doc), /A second paragraph/);
    assert.match(textOf(live.doc), /sleepy dog/);
  });
});

// ---------------------------------------------------------------------------

describe("review", () => {
  function twoEdits() {
    const live = makeLive();
    agentEdit(live, "quick", "speedy");
    agentEdit(live, "second paragraph", "final line");
    assert.equal(live.hunks.length, 2);
    return live;
  }

  it("accepting one hunk keeps the text and emits a hunks event", () => {
    const live = twoEdits();
    const { events } = record(live);
    const doc = live.doc;
    const version = live.version;
    const [first, second] = live.hunks;
    assert.deepEqual(live.review("accept", [first!.id]), { changed: false });
    assert.equal(live.doc, doc);
    assert.equal(live.version, version);
    assert.deepEqual(live.hunks.map((h) => h.id), [second!.id]);
    assert.deepEqual(events, [{ type: "hunks", version, hunks: live.hunksJSON() }]);
  });

  it("accepting all clears every hunk", () => {
    const live = twoEdits();
    live.review("accept", "all");
    assert.equal(live.hunks.length, 0);
    assert.match(textOf(live.doc), /speedy brown fox/);
  });

  it("rejecting one hunk restores its text, keeps the other and broadcasts steps", () => {
    const live = twoEdits();
    const { of } = record(live);
    const [first] = live.hunks;
    assert.deepEqual(live.review("reject", [first!.id]), { changed: true });
    assert.match(textOf(live.doc), /The quick brown fox/);
    assert.match(textOf(live.doc), /A final line stays put/);
    assert.deepEqual(hunkTexts(live), [{ inserted: "final line", deleted: "second paragraph" }]);
    const event = of("steps")[0]!;
    assert.ok(event.clientIDs.every((id) => id === "system:review"));
    assert.equal(event.hunks!.length, 1);
  });

  it("rejecting all returns the document to its pre-agent state", () => {
    const live = makeLive();
    const original = live.doc;
    agentEdit(live, "quick", "speedy");
    agentEdit(live, "lazy dog", "tired cat");
    agentEdit(live, "A second paragraph stays put.", "A second paragraph stays put.\n\nAnd a brand new one.");
    agentEdit(live, "The speedy brown fox jumps over the tired cat.\n\n", "");
    live.review("reject", "all");
    assert.equal(live.hunks.length, 0);
    assert.equal(textOf(live.doc), textOf(original));
  });

  it(
    "rejecting a paragraph split restores the original paragraph exactly",
    () => {
      const live = makeLive();
      const original = textOf(live.doc);
      agentEdit(live, "A second paragraph stays put.", "Replaced.\n\nWith two paragraphs.");
      live.review("reject", "all");
      assert.equal(textOf(live.doc), original);
    },
  );

  it(
    "rejecting all after one agent edit that changes two words restores the original",
    () => {
      const live = makeLive();
      const original = textOf(live.doc);
      agentEdit(live, "quick brown fox jumps", "slow brown fox leaps");
      // Currently: two overlapping hunks; reject-all leaves "The jumps over the lazy dog."
      live.review("reject", "all");
      assert.equal(textOf(live.doc), original);
    },
  );

  it("rejecting unknown ids changes nothing but still reports the hunks", () => {
    const live = twoEdits();
    const { of } = record(live);
    const doc = live.doc;
    assert.deepEqual(live.review("reject", ["nope"]), { changed: false });
    assert.equal(live.doc, doc);
    assert.equal(live.hunks.length, 2);
    assert.equal(of("hunks").length, 1);
  });
});

// ---------------------------------------------------------------------------

describe("selection", () => {
  it("setSelection ignores stale versions and clamps to the document", () => {
    const live = makeLive();
    live.setSelection({ from: 1, to: 4, version: 3 });
    assert.equal(live.selection, null);
    live.setSelection({ from: -5, to: 99999, version: 0 });
    assert.deepEqual({ ...live.selection!, at: 0 }, { from: 0, to: live.doc.content.size, version: 0, at: 0 });
    live.setSelection({ from: 10, to: 2, version: 0 });
    assert.equal(live.selection!.from, 10);
    assert.equal(live.selection!.to, 10);
  });

  it("maps the selection through later edits by anyone", () => {
    const live = makeLive();
    const r = range(live.doc, "lazy dog");
    live.setSelection({ ...r, version: 0 });
    live.receiveClientSteps(0, insertSteps(live.doc, 1, "Well, "), "a");
    assert.equal(live.selection!.version, 1);
    assert.equal(live.doc.textBetween(live.selection!.from, live.selection!.to), "lazy dog");
    agentEdit(live, "quick brown", "slow");
    assert.equal(live.selection!.version, live.version);
    assert.equal(live.doc.textBetween(live.selection!.from, live.selection!.to), "lazy dog");
  });
});

// ---------------------------------------------------------------------------

describe("comments", () => {
  function commentIds(doc: PMNode) {
    const ids = new Set<string>();
    doc.descendants((node) => {
      for (const mark of node.marks) if (mark.type.name === "comment") ids.add(mark.attrs.id as string);
    });
    return ids;
  }

  it("addComment anchors a comment mark, records the quote and creates no hunk", () => {
    const live = makeLive();
    agentEdit(live, "quick", "speedy");
    const r = range(live.doc, "lazy dog");
    const { of } = record(live);
    const comment = live.addComment({ ...r, body: "  Too harsh?  ", author: "claude" }, { kind: "agent", author: "chat-1" });
    assert.equal(comment.body, "Too harsh?");
    assert.equal(comment.quote, "lazy dog");
    assert.equal(comment.resolved, false);
    assert.deepEqual(comment.replies, []);
    assert.ok(commentIds(live.doc).has(comment.id));
    // Only the earlier agent hunk remains: comments are not content changes.
    assert.deepEqual(hunkTexts(live), [{ inserted: "speedy", deleted: "quick" }]);
    // Agent comments are applied as a system change, not an agent edit.
    assert.ok(of("steps")[0]!.clientIDs.every((id) => id === "system:comment"));
    assert.deepEqual(live.commentsWithAnchors()[0]!.anchor, { text: "lazy dog", from: r.from, to: r.to });
  });

  it("reply, resolve and edit update the thread; unknown ids throw for reply/resolve", () => {
    const live = makeLive();
    const r = range(live.doc, "fox");
    const comment = live.addComment({ ...r, body: "Why a fox?", author: "user" }, { kind: "client", clientID: "a" });
    const { of } = record(live);
    const reply = live.replyToComment(comment.id, " Because. ", "claude");
    assert.equal(reply.body, "Because.");
    live.setCommentResolved(comment.id, true);
    live.editComment(comment.id, " Why a fox, really? ");
    const [stored] = live.comments;
    assert.equal(stored!.body, "Why a fox, really?");
    assert.equal(stored!.resolved, true);
    assert.deepEqual(stored!.replies.map((x) => x.body), ["Because."]);
    assert.equal(of("comments").length, 3);
    assert.throws(() => live.replyToComment("missing", "x", "user"), /No comment/);
    assert.throws(() => live.setCommentResolved("missing", true), /No comment/);
  });

  it("deleteComment removes the comment and its marks without touching hunks", () => {
    const live = makeLive();
    agentEdit(live, "lazy", "sleepy");
    const keep = live.addComment({ ...range(live.doc, "quick"), body: "keep", author: "user" }, { kind: "client", clientID: "a" });
    const drop = live.addComment({ ...range(live.doc, "brown fox"), body: "drop", author: "user" }, { kind: "client", clientID: "a" });
    const text = textOf(live.doc);
    live.deleteComment(drop.id);
    assert.deepEqual(live.comments.map((c) => c.id), [keep.id]);
    assert.deepEqual([...commentIds(live.doc)], [keep.id]);
    assert.equal(textOf(live.doc), text);
    assert.deepEqual(hunkTexts(live), [{ inserted: "sleepy", deleted: "lazy" }]);
  });

  it("comment marks survive later edits and the anchor follows the text", () => {
    const live = makeLive();
    const c = live.addComment({ ...range(live.doc, "second paragraph"), body: "x", author: "user" }, { kind: "client", clientID: "a" });
    live.receiveClientSteps(live.version, insertSteps(live.doc, 1, "Prefix "), "a");
    assert.equal(live.commentsWithAnchors().find((x) => x.id === c.id)!.anchor!.text, "second paragraph");
  });
});

// ---------------------------------------------------------------------------

describe("versions", () => {
  it("saveVersion stores a summary; versions lists newest first", async () => {
    const live = await documentHub().create({ title: "Versioned", markdown: SAMPLE });
    const first = await live.saveVersion("  ", "user");
    assert.equal(first.label, "Saved version");
    assert.equal(first.documentId, live.id);
    assert.equal(first.title, "Versioned");
    assert.equal(first.wordCount, 14);
    assert.equal("doc" in first, false);
    await sleep(3);
    const second = await live.saveVersion("Draft 2", "claude");
    const listed = await live.versions();
    assert.deepEqual(listed.map((v) => v.id), [second.id, first.id]);
    assert.equal(listed.some((v) => "doc" in v), false);
  });

  it("restoreVersion snapshots the current state (with its pending changes) first, then restores the version's own", async () => {
    const live = await documentHub().create({ title: "Restore", markdown: SAMPLE });
    const saved = await live.saveVersion("Clean", "user");
    const original = textOf(live.doc);
    agentEdit(live, "lazy dog", "sleepy cat");
    live.receiveClientSteps(live.version, insertSteps(live.doc, 1, "Edited: "), "a");
    const edited = textOf(live.doc);
    assert.equal(live.hunks.length, 1);
    await sleep(3);
    const { of } = record(live);
    const restored = await live.restoreVersion(saved.id);
    assert.equal(restored.id, saved.id);
    assert.equal(textOf(live.doc), original);
    assert.equal(live.hunks.length, 0);
    assert.ok(of("steps")[0]!.clientIDs.every((id) => id === "system:restore"));
    const versions = await live.versions();
    const backup = versions.find((v) => v.label === "Before restoring a version");
    assert.ok(backup);
    assert.equal(backup.author, "auto");
    // The backup holds the edited text, so the restore itself can be undone.
    assert.equal(backup.pendingChanges, 1, "the pending change is kept in the backup");
    await live.restoreVersion(backup.id);
    assert.equal(textOf(live.doc), edited);
    // ...and restoring it brings the pending change back, still reviewable.
    assert.equal(live.hunks.length, 1);
    assert.equal(live.hunksJSON()[0]!.insertedText, "sleepy cat");
    live.review("reject", "all");
    assert.match(textOf(live.doc), /lazy dog/);
    await assert.rejects(live.restoreVersion("nope"), /Version not found/);
  });

  it("checkpoint saves only when there are changes since the last version", async () => {
    const live = await documentHub().create({ markdown: SAMPLE });
    const first = await live.checkpoint("Before Claude");
    assert.equal((await live.versions()).find((version) => version.id === first)?.label, "Before Claude");
    assert.equal(await live.checkpoint("Before Claude"), first, "no changes: the same version");
    live.receiveClientSteps(live.version, insertSteps(live.doc, 1, "x"), "a");
    const second = await live.checkpoint("Before Claude again");
    assert.notEqual(second, first);
    assert.equal(await live.checkpoint("again"), second);
    assert.equal((await live.versions()).length, 2);
  });
});

// ---------------------------------------------------------------------------

describe("persistence", () => {
  it("flush writes a file that a fresh hub reloads identically (doc, comments, hunks)", async () => {
    const hub = documentHub();
    const live = await hub.create({ title: "Persisted", markdown: SAMPLE });
    agentEdit(live, "lazy dog", "sleepy cat", "chat-7");
    live.addComment({ ...range(live.doc, "quick"), body: "c1", author: "user" }, { kind: "client", clientID: "a" });
    await live.flush();
    const onDisk = JSON.parse(readFileSync(path.join(dataDir(), "documents", `${live.id}.json`), "utf8")) as StoredDocumentFile;
    assert.equal(onDisk.format, 3);
    assert.equal(onDisk.meta.wordCount, 14);
    assert.match(onDisk.meta.preview, /sleepy cat/);

    const reloaded = await freshHub().get(live.id);
    assert.ok(reloaded);
    assert.notEqual(reloaded, live);
    assert.ok(reloaded.doc.eq(live.doc));
    assert.deepEqual(reloaded.comments, live.comments);
    assert.deepEqual(reloaded.hunksJSON(), live.hunksJSON());
    assert.equal(reloaded.meta.title, "Persisted");
    // A reloaded hunk is still reversible.
    reloaded.review("reject", "all");
    assert.match(textOf(reloaded.doc), /lazy dog/);
  });

  it("an edit schedules a debounced write", async () => {
    const live = await documentHub().create({ markdown: "Draft" });
    live.receiveClientSteps(0, insertSteps(live.doc, 1, "Final "), "a");
    assert.doesNotMatch(JSON.stringify((await readDocumentFile(live.id))!.doc), /Final/);
    await sleep(700);
    assert.match(JSON.stringify((await readDocumentFile(live.id))!.doc), /Final Draft/);
  });

  it("auto titles follow the first non-empty line until the user names the document", async () => {
    const live = await documentHub().create({ markdown: "&nbsp;\n\nPlaceholder" });
    const { of } = record(live);
    const r = range(live.doc, "Placeholder");
    const tr = new Transform(live.doc).replaceWith(r.from, r.to, schema.text("Quarterly   planning notes"));
    live.receiveClientSteps(0, tr.steps.map((s) => s.toJSON()), "a");
    await live.flush();
    assert.equal(live.meta.title, "Quarterly planning notes");
    assert.equal(of("meta").at(-1)!.meta.title, "Quarterly planning notes");
    live.updateMeta({ title: "My name" });
    live.receiveClientSteps(live.version, insertSteps(live.doc, live.doc.content.size - 1, " more"), "a");
    await live.flush();
    assert.equal(live.meta.title, "My name");
  });

  it("drops hunks beyond the document and hunks that fail to parse on load", () => {
    const doc = ensureBlockIds(markdownToDoc("Short."));
    const good: Hunk = { id: "good", from: 1, to: 3, deleted: Slice.empty, author: "chat", createdAt: 1 };
    const far: Hunk = { ...good, id: "far", from: 2, to: doc.content.size + 5 };
    const broken = { ...hunkToJSON(good, doc), id: "broken", deleted: { content: [{ type: "no-such-node" }] } };
    const live = new LiveDocument({
      format: 3,
      meta: meta(),
      doc: doc.toJSON(),
      comments: "not an array" as unknown as [],
      hunks: [hunkToJSON(good, doc), hunkToJSON(far, doc), broken as never],
    });
    assert.deepEqual(live.hunks.map((h) => h.id), ["good"]);
    assert.deepEqual(live.comments, []);
  });

  it("a corrupt document loads as an empty document", () => {
    const live = new LiveDocument({ format: 3, meta: meta(), doc: { type: "doc", content: [{ type: "bogus" }] }, comments: [], hunks: [] });
    assert.equal(live.doc.childCount, 1);
    assert.equal(live.doc.firstChild!.type.name, "paragraph");
    assert.equal(typeof live.doc.firstChild!.attrs.id, "string");
    // Invalid content (text directly in the doc) is caught by doc.check().
    const invalid = loadDoc({ type: "doc", content: [{ type: "text", text: "loose" }] });
    assert.equal(invalid.textContent, "");
    assert.equal(loadDoc(null).childCount, 1);
  });

  it("a corrupt file on disk loads as an empty document through the hub", async () => {
    const live = await documentHub().create({ markdown: "Will be corrupted" });
    await live.flush();
    const { writeDocumentFile } = await import("@/lib/server/store");
    await writeDocumentFile({ ...live.toFile(), doc: "garbage", hunks: [{ id: "h" } as never] });
    const reloaded = await freshHub().get(live.id);
    assert.ok(reloaded);
    assert.equal(reloaded.doc.textContent, "");
    assert.equal(reloaded.hunks.length, 0);
  });

  it("markDeleted stops edits, persistence and further events", async () => {
    const live = await documentHub().create({ markdown: "Doomed" });
    await live.flush();
    const file = path.join(dataDir(), "documents", `${live.id}.json`);
    const { events } = record(live);
    live.markDeleted();
    assert.deepEqual(events.map((e) => e.type), ["deleted"]);
    assert.throws(() => live.receiveClientSteps(0, insertSteps(live.doc, 1, "x"), "a"), /deleted/);
    assert.throws(() => live.applyTransform(new Transform(live.doc).insert(1, schema.text("x")), { kind: "system", label: "s" }), /deleted/);
    const before = readFileSync(file, "utf8");
    live.updateMeta({ title: "Changed after delete" });
    await live.flush();
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(events.length, 1);
  });
});

describe("document epochs", () => {
  it("each load of a document gets its own epoch, carried by snapshots and resets", () => {
    const a = makeLive();
    const b = new LiveDocument(a.toFile());
    assert.notEqual(a.epoch, b.epoch);
    assert.equal(a.snapshot().epoch, a.epoch);
    const reset = a.resetEvent();
    assert.equal(reset.type === "reset" && reset.epoch, a.epoch);
  });

  it("refuses steps from an earlier load even when the version numbers happen to line up", () => {
    const first = makeLive();
    const restarted = new LiveDocument(first.toFile());
    assert.equal(restarted.version, 0);
    const before = restarted.doc;
    assert.throws(
      () => restarted.receiveClientSteps(0, insertSteps(before, 1, "X"), "a", { epoch: first.epoch }),
      (error: unknown) => error instanceof StaleEpochError && error.epoch === restarted.epoch,
    );
    assert.equal(restarted.doc, before);
    assert.equal(restarted.receiveClientSteps(0, insertSteps(before, 1, "X"), "a", { epoch: restarted.epoch }), 1);
  });
});

describe("trash", () => {
  it("trashed documents stay however old they are, until emptyTrash deletes them (and only them)", async () => {
    const hub = freshHub();
    const keep = await hub.create({ title: "Keep", markdown: "a" });
    const recent = await hub.create({ title: "Recent", markdown: "b" });
    const old = await hub.create({ title: "Old", markdown: "c" });
    recent.setTrashed(true);
    old.setTrashed(true);
    old.meta = { ...old.meta, trashedAt: Date.now() - 400 * 24 * 60 * 60 * 1000 };
    await old.flush();
    await recent.flush();

    const listed = await hub.list({ trashed: true });
    const ids = listed.map((meta) => meta.id);
    assert.ok(ids.includes(recent.id));
    assert.ok(ids.includes(old.id), "a document trashed over a year ago is still there");
    assert.ok(await hub.get(old.id));

    assert.ok((await hub.emptyTrash()) >= 1);
    assert.equal(await hub.get(recent.id), null);
    assert.equal((await hub.list({ trashed: true })).length, 0);
    assert.ok(await hub.get(keep.id));
  });
});

describe("unloading idle documents", () => {
  it("unloads saved, unwatched documents and reloads them from disk with a new epoch", async () => {
    const hub = freshHub();
    const doc = await hub.create({ markdown: SAMPLE });
    doc.receiveClientSteps(0, insertSteps(doc.doc, 1, "Saved "), "a");
    const watched = await hub.create({ markdown: "watched" });
    const stop = watched.subscribe(() => undefined);

    // Pending saves keep it loaded until they're written.
    assert.equal(await hub.unloadIdle(0), 0);
    await doc.flush();
    await hub.unloadIdle(0);
    const reloaded = (await hub.get(doc.id))!;
    assert.notEqual(reloaded, doc);
    assert.notEqual(reloaded.epoch, doc.epoch);
    assert.match(textOf(reloaded.doc), /^Saved The quick/);
    assert.equal(await hub.get(watched.id), watched, "a watched document stays loaded");
    stop();
  });

  it("keeps recently used documents", async () => {
    const hub = freshHub();
    const doc = await hub.create({ markdown: SAMPLE });
    await doc.flush();
    assert.equal(await hub.unloadIdle(60_000), 0);
    assert.equal(await hub.get(doc.id), doc);
  });
});

describe("DocumentHub tabs", () => {
  it("tabs share one title, stay out of the document list, and follow renames, moves and deletes", async () => {
    const hub = freshHub();
    const root = await hub.create({ title: "Report", markdown: "## Plan\n\nFirst tab." });
    const second = await hub.createTab(root.id, { title: "Notes", markdown: "Second tab." });
    const third = await hub.createTab(second.id);
    assert.deepEqual(
      (await hub.tabs(third.id)).map(({ outline: _, ...tab }) => tab),
      [
        { id: root.id, title: "Tab 1", root: true },
        { id: second.id, title: "Notes" },
        { id: third.id, title: "Tab 3" },
      ],
    );
    assert.equal(second.meta.parentId, root.id);
    assert.equal(second.meta.title, "Report");
    assert.deepEqual((await hub.tabs(root.id))[0]!.outline, [{ pos: 0, level: 2, text: "Plan" }]);
    const listed = (await hub.list()).map((meta) => meta.id);
    assert.ok(listed.includes(root.id));
    assert.ok(!listed.includes(second.id) && !listed.includes(third.id));

    // Renaming any tab's document title renames them all.
    second.updateMeta({ title: "Annual report" });
    await sleep(10);
    assert.equal(root.meta.title, "Annual report");
    assert.equal(third.meta.title, "Annual report");

    const events: HubEvent[] = [];
    const stop = root.subscribe((event) => events.push(event));
    await hub.renameTab(third.id, "Appendix");
    await hub.moveTab(third.id, 0);
    assert.deepEqual(
      (await hub.tabs(root.id)).map((tab) => tab.title),
      ["Appendix", "Tab 1", "Notes"],
    );
    // Any tab can move, the root included; names stay put.
    await hub.moveTab(root.id, 2);
    assert.deepEqual(
      (await hub.tabs(root.id)).map((tab) => tab.title),
      ["Appendix", "Notes", "Tab 1"],
    );
    assert.ok(events.some((event) => event.type === "tabs"));
    stop();

    await hub.deleteTab(second.id);
    assert.deepEqual((await hub.tabs(root.id)).map((tab) => tab.id), [third.id, root.id]);
    assert.equal(await hub.get(second.id), null);

    // Duplicating copies every tab in order.
    const copy = await hub.duplicate(third.id);
    assert.deepEqual((await hub.tabs(copy.id)).map((tab) => tab.title), ["Appendix", "Tab 1"]);

    // Deleting the root hands the document to the next tab.
    const next = await hub.deleteTab(root.id);
    assert.equal(next.id, third.id);
    assert.equal(third.meta.parentId, undefined);
    assert.equal(third.meta.title, "Annual report");
    assert.deepEqual((await hub.tabs(third.id)).map(({ outline: _, ...tab }) => tab), [{ id: third.id, title: "Appendix", root: true }]);
    assert.ok((await hub.list()).some((meta) => meta.id === third.id));
    await assert.rejects(hub.deleteTab(third.id), /at least one tab/);

    // Deleting a document deletes its tabs.
    const tabs = (await hub.tabs(copy.id)).map((tab) => tab.id);
    await hub.remove(copy.id);
    for (const id of tabs) assert.equal(await hub.get(id), null);
  });
});

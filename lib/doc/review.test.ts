import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Transform } from "prosemirror-transform";
import { applyFormat, applyStringEdit, findText } from "./editing";
import { ensureBlockIds } from "./ids";
import { docToMarkdown, markdownToDoc } from "./markdown";
import { schema } from "./schema";
import { acceptHunks, changedRanges, hunkFromJSON, hunkToJSON, mapHunks, recordAgentChange, rejectHunks, type Hunk } from "./review";

const base = () => ensureBlockIds(markdownToDoc("The quick brown fox jumps over the lazy dog.\n\nA second paragraph stays put."));

function agentEdit(doc: ReturnType<typeof base>, hunks: Hunk[], old_string: string, new_string: string) {
  const tr = new Transform(doc);
  applyStringEdit(tr, { old_string, new_string });
  return { doc: tr.doc, hunks: recordAgentChange(doc, tr, hunks, "chat-1") };
}

describe("review hunks", () => {
  it("records a word-level hunk and can undo it", () => {
    const start = base();
    const { doc, hunks } = agentEdit(start, [], "quick brown fox", "slow red fox");
    assert.equal(hunks.length, 1);
    assert.equal(doc.textBetween(hunks[0]!.from, hunks[0]!.to), "slow red");
    assert.equal(hunks[0]!.deleted.content.textBetween(0, hunks[0]!.deleted.content.size), "quick brown");
    const { tr, remaining } = rejectHunks(doc, hunks, "all");
    assert.equal(remaining.length, 0);
    assert.equal(docToMarkdown(tr.doc), docToMarkdown(start));
  });

  it("keeps separate edits independently reversible", () => {
    const start = base();
    let state = agentEdit(start, [], "quick", "speedy");
    state = agentEdit(state.doc, state.hunks, "lazy dog", "sleepy cat");
    assert.equal(state.hunks.length, 2);
    const firstId = state.hunks[0]!.id;
    const { tr, remaining } = rejectHunks(state.doc, state.hunks, new Set([firstId]));
    assert.equal(tr.doc.firstChild!.textContent, "The quick brown fox jumps over the sleepy cat.");
    assert.equal(remaining.length, 1);
    assert.equal(tr.doc.textBetween(remaining[0]!.from, remaining[0]!.to), "sleepy cat");
  });

  it("merges an edit of pending agent text so undo restores the original", () => {
    const start = base();
    let state = agentEdit(start, [], "brown fox", "red fox");
    state = agentEdit(state.doc, state.hunks, "red fox jumps", "crimson wolf leaps");
    assert.equal(state.hunks.length, 1);
    const { tr } = rejectHunks(state.doc, state.hunks, "all");
    assert.equal(docToMarkdown(tr.doc), docToMarkdown(start));
  });

  it("maps hunks through user typing", () => {
    const start = base();
    const state = agentEdit(start, [], "lazy", "sleepy");
    const typing = new Transform(state.doc).insert(1, schema.text("Well, "));
    const mapped = mapHunks(state.hunks, typing.mapping);
    assert.equal(typing.doc.textBetween(mapped[0]!.from, mapped[0]!.to), "sleepy");
    const { tr } = rejectHunks(typing.doc, mapped, "all");
    assert.equal(tr.doc.firstChild!.textContent, "Well, The quick brown fox jumps over the lazy dog.");
  });

  it("tracks formatting-only changes", () => {
    const start = base();
    const tr = new Transform(start);
    const [hit] = findText(start, "brown fox");
    applyFormat(tr, hit!.from, hit!.to, { bold: true });
    const hunks = recordAgentChange(start, tr, [], "chat-1");
    assert.equal(hunks.length, 1);
    const undone = rejectHunks(tr.doc, hunks, "all").tr.doc;
    assert.ok(undone.eq(start));
  });

  it("accepting drops the hunk and keeps the text", () => {
    const state = agentEdit(base(), [], "quick", "fast");
    assert.deepEqual(acceptHunks(state.hunks, "all"), []);
  });

  it("records block insertions and deletions", () => {
    const start = base();
    let state = agentEdit(start, [], "A second paragraph stays put.", "A second paragraph stays put.\n\nA brand new paragraph.");
    assert.equal(state.hunks.length, 1);
    state = agentEdit(state.doc, state.hunks, "The quick brown fox jumps over the lazy dog.\n\n", "");
    const { tr } = rejectHunks(state.doc, state.hunks, "all");
    assert.equal(docToMarkdown(tr.doc), docToMarkdown(start));
  });
});

const text = (doc: ReturnType<typeof base>, from: number, to: number) => doc.textBetween(from, to, "\n");
const deletedText = (hunk: Hunk) => hunk.deleted.content.textBetween(0, hunk.deleted.content.size, "\n");

describe("changedRanges", () => {
  it("reports a single changed word in before and after coordinates", () => {
    const start = base();
    const tr = new Transform(start);
    applyStringEdit(tr, { old_string: "brown", new_string: "red" });
    const ranges = changedRanges(start, tr);
    assert.equal(ranges.length, 1);
    const [r] = ranges;
    assert.equal(text(start, r!.fromA, r!.toA), "brown");
    assert.equal(text(tr.doc, r!.fromB, r!.toB), "red");
  });

  it("widens character-level changes to whole words", () => {
    const start = base();
    const tr = new Transform(start);
    applyStringEdit(tr, { old_string: "jumps", new_string: "jumped" });
    const [r] = changedRanges(start, tr);
    assert.equal(text(start, r!.fromA, r!.toA), "jumps");
    assert.equal(text(tr.doc, r!.fromB, r!.toB), "jumped");
  });

  it("detects mark-only changes such as bold", () => {
    const start = base();
    const tr = new Transform(start);
    const [hit] = findText(start, "lazy");
    applyFormat(tr, hit!.from, hit!.to, { bold: true });
    assert.equal(tr.doc.textContent, start.textContent);
    const ranges = changedRanges(start, tr);
    assert.equal(ranges.length, 1);
    assert.equal(text(tr.doc, ranges[0]!.fromB, ranges[0]!.toB), "lazy");
    assert.equal(text(start, ranges[0]!.fromA, ranges[0]!.toA), "lazy");
  });

  it("merges word changes separated only by a space, but not distant ones", () => {
    const start = base();
    const near = new Transform(start);
    applyStringEdit(near, { old_string: "quick brown fox", new_string: "slow red fox" });
    const merged = changedRanges(start, near);
    assert.equal(merged.length, 1);
    assert.equal(text(near.doc, merged[0]!.fromB, merged[0]!.toB), "slow red");

    const far = new Transform(start);
    applyStringEdit(far, { old_string: "quick brown fox jumps over the lazy", new_string: "slow brown fox jumps over the sleepy" });
    const separate = changedRanges(start, far);
    assert.deepEqual(
      separate.map((r) => text(far.doc, r.fromB, r.toB)),
      ["slow", "sleepy"],
    );
  });

  it("does not merge changes in different paragraphs", () => {
    const start = base();
    const tr = new Transform(start);
    applyStringEdit(tr, { old_string: "dog.\n\nA second", new_string: "cat.\n\nThe second" });
    const ranges = changedRanges(start, tr);
    assert.deepEqual(
      ranges.map((r) => text(tr.doc, r.fromB, r.toB)),
      ["cat", "The"],
    );
  });

  it("returns nothing for a transform without changes", () => {
    const start = base();
    assert.deepEqual(changedRanges(start, new Transform(start)), []);
  });
});

describe("review hunks: merging and undo", () => {
  it("successive overlapping agent edits merge into one hunk whose undo restores the original", () => {
    const start = base();
    let state = agentEdit(start, [], "quick", "fast");
    state = agentEdit(state.doc, state.hunks, "fast brown", "rapid grey");
    state = agentEdit(state.doc, state.hunks, "rapid grey fox", "rapid grey wolf");
    // "wolf" is a separate word next to the hunk, not inside it, so it stays its own hunk.
    assert.deepEqual(
      state.hunks.map((h) => [text(state.doc, h.from, h.to), deletedText(h)]),
      [
        ["rapid grey", "quick brown"],
        ["wolf", "fox"],
      ],
    );
    state = agentEdit(state.doc, state.hunks, "grey wolf", "silver hound");
    assert.equal(state.hunks.length, 1);
    assert.equal(deletedText(state.hunks[0]!), "quick brown fox");
    assert.equal(text(state.doc, state.hunks[0]!.from, state.hunks[0]!.to), "rapid silver hound");
    const { tr } = rejectHunks(state.doc, state.hunks, "all");
    assert.equal(docToMarkdown(tr.doc), docToMarkdown(start));
  });

  it("an overlapping edit keeps the id and createdAt of the hunk it absorbs", () => {
    const start = base();
    const tr1 = new Transform(start);
    applyStringEdit(tr1, { old_string: "lazy", new_string: "sleepy" });
    const first = recordAgentChange(start, tr1, [], "chat-1", 1000);
    const tr2 = new Transform(tr1.doc);
    applyStringEdit(tr2, { old_string: "sleepy", new_string: "drowsy" });
    const second = recordAgentChange(tr1.doc, tr2, first, "chat-2", 2000);
    assert.equal(second.length, 1);
    assert.equal(second[0]!.id, first[0]!.id);
    assert.equal(second[0]!.createdAt, 1000);
    assert.equal(second[0]!.author, "chat-2");
    assert.equal(deletedText(second[0]!), "lazy");
  });

  it("an edit that restores the original text removes the hunk", () => {
    const start = base();
    let state = agentEdit(start, [], "lazy dog", "sleepy cat");
    assert.equal(state.hunks.length, 1);
    state = agentEdit(state.doc, state.hunks, "sleepy cat", "lazy dog");
    assert.equal(state.hunks.length, 0);
    assert.ok(state.doc.eq(start));
  });

  it("toggling bold on and off again leaves no hunk", () => {
    const start = base();
    const [hit] = findText(start, "fox");
    const on = new Transform(start);
    applyFormat(on, hit!.from, hit!.to, { bold: true });
    const afterOn = recordAgentChange(start, on, [], "chat-1");
    assert.equal(afterOn.length, 1);
    const off = new Transform(on.doc);
    applyFormat(off, hit!.from, hit!.to, { bold: false });
    assert.deepEqual(recordAgentChange(on.doc, off, afterOn, "chat-1"), []);
  });

  it("rejecting one of several hunks leaves the others pointing at their text", () => {
    const start = base();
    let state = agentEdit(start, [], "quick", "speedy");
    state = agentEdit(state.doc, state.hunks, "lazy", "sleepy");
    state = agentEdit(state.doc, state.hunks, "second", "final");
    assert.equal(state.hunks.length, 3);
    assert.deepEqual(
      state.hunks.map((h) => text(state.doc, h.from, h.to)),
      ["speedy", "sleepy", "final"],
    );
    const middle = state.hunks[1]!;
    const { tr, remaining } = rejectHunks(state.doc, state.hunks, new Set([middle.id]));
    assert.equal(tr.doc.firstChild!.textContent, "The speedy brown fox jumps over the lazy dog.");
    assert.deepEqual(
      remaining.map((h) => [text(tr.doc, h.from, h.to), deletedText(h)]),
      [
        ["speedy", "quick"],
        ["final", "second"],
      ],
    );
    const rest = rejectHunks(tr.doc, remaining, "all");
    assert.equal(docToMarkdown(rest.tr.doc), docToMarkdown(start));
  });

  it("rejecting after the user edits elsewhere maps correctly", () => {
    const start = base();
    let state = agentEdit(start, [], "lazy dog", "sleepy cat");
    state = agentEdit(state.doc, state.hunks, "stays put", "moves");
    // The user deletes "The " before the first hunk and appends to the second paragraph.
    const user = new Transform(state.doc);
    user.delete(1, 5);
    const end = user.doc.content.size - 1;
    user.insert(end, schema.text(" Really."));
    const hunks = mapHunks(state.hunks, user.mapping);
    assert.deepEqual(
      hunks.map((h) => text(user.doc, h.from, h.to)),
      ["sleepy cat", "moves"],
    );
    const first = rejectHunks(user.doc, hunks, new Set([hunks[0]!.id]));
    assert.equal(first.tr.doc.firstChild!.textContent, "quick brown fox jumps over the lazy dog.");
    assert.equal(text(first.tr.doc, first.remaining[0]!.from, first.remaining[0]!.to), "moves");
    const all = rejectHunks(first.tr.doc, first.remaining, "all");
    assert.equal(all.tr.doc.lastChild!.textContent, "A second paragraph stays put. Really.");
  });

  it("mapHunks drops a hunk whose insertion was deleted, but keeps a pure deletion as a point", () => {
    const start = base();
    let state = agentEdit(start, [], "lazy dog", "sleepy cat");
    const [hunk] = state.hunks;
    const wipe = new Transform(state.doc).delete(hunk!.from, hunk!.to);
    const mapped = mapHunks(state.hunks, wipe.mapping);
    // The deleted slice is still there to restore, so the hunk survives collapsed.
    assert.equal(mapped.length, 1);
    assert.equal(mapped[0]!.from, mapped[0]!.to);
    const restored = rejectHunks(wipe.doc, mapped, "all").tr.doc;
    assert.equal(restored.firstChild!.textContent, "The quick brown fox jumps over the lazy dog.");

    state = agentEdit(start, [], "A second paragraph stays put.", "A second paragraph stays put.\n\nExtra.");
    const inserted = state.hunks[0]!;
    assert.equal(inserted.deleted.size, 0);
    const drop = new Transform(state.doc).delete(inserted.from, inserted.to);
    assert.deepEqual(mapHunks(state.hunks, drop.mapping), []);
  });

  it("acceptHunks with a set keeps the rest", () => {
    const start = base();
    let state = agentEdit(start, [], "quick", "speedy");
    state = agentEdit(state.doc, state.hunks, "second", "final");
    const kept = acceptHunks(state.hunks, new Set([state.hunks[0]!.id]));
    assert.deepEqual(kept.map((h) => h.id), [state.hunks[1]!.id]);
  });

  it("hunkToJSON / hunkFromJSON round-trips through JSON text", () => {
    const start = base();
    const state = agentEdit(start, [], "stays put", "**moves** along");
    const [hunk] = state.hunks;
    const json = hunkToJSON(hunk!, state.doc);
    assert.equal(json.deletedText, "stays put");
    assert.equal(json.insertedText, "moves along");
    assert.equal(json.author, "chat-1");
    const back = hunkFromJSON(JSON.parse(JSON.stringify(json)), schema);
    assert.deepEqual(
      { ...back, deleted: back.deleted.toJSON() },
      { ...hunk!, deleted: hunk!.deleted.toJSON() },
    );
    assert.ok(back.deleted.eq(hunk!.deleted));
    const undone = rejectHunks(state.doc, [back], "all").tr.doc;
    assert.equal(docToMarkdown(undone), docToMarkdown(start));
  });

  it("hunkToJSON tolerates a hunk that no longer fits the document", () => {
    const start = base();
    const state = agentEdit(start, [], "quick", "speedy");
    const json = hunkToJSON({ ...state.hunks[0]!, to: 99999 }, state.doc);
    assert.equal(json.insertedText, "");
    assert.equal(json.deletedText, "quick");
  });
});

/**
 * BUG (lib/doc/review.ts, recordAgentChange): the hunk's range in the new document is
 * widened with `tr.mapping.map(fromA/toA)`. Positions inside a replaced step collapse to
 * the step's edges, so when one step covers several word-level changes, every hunk spans
 * the whole step while its `deleted` slice holds only its own word. Hunks overlap and
 * undoing them destroys text.
 */
describe("review hunks: multi-change steps", () => {
  const cases: Array<[string, string]> = [
    ["quick brown fox jumps", "slow brown fox leaps"],
    ["over the lazy", "under the sleepy"],
    ["The quick brown fox jumps over the lazy dog.", "A quick brown fox jumped over a lazy dog."],
    ["A second paragraph stays put.", "New first.\n\nNew **second**."],
  ];
  for (const [old_string, new_string] of cases) {
    it(
      `undoing all hunks of "${old_string}" -> "${new_string.replace(/\n/g, "\\n")}" restores the original`,
      () => {
        const start = base();
        const state = agentEdit(start, [], old_string, new_string);
        const sorted = [...state.hunks].sort((a, b) => a.from - b.from);
        for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i]!.from >= sorted[i - 1]!.to, "hunks overlap");
        const { tr } = rejectHunks(state.doc, state.hunks, "all");
        assert.equal(docToMarkdown(tr.doc), docToMarkdown(start));
      },
    );
  }

  it(
    "a pending hunk inside the span of a later multi-word edit stays reversible",
    () => {
      const start = base();
      let state = agentEdit(start, [], "brown", "red");
      state = agentEdit(state.doc, state.hunks, "quick red fox", "slow red wolf");
      const sorted = [...state.hunks].sort((a, b) => a.from - b.from);
      for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i]!.from >= sorted[i - 1]!.to, "hunks overlap");
      assert.ok(state.hunks.some((h) => text(state.doc, h.from, h.to) === "red" && deletedText(h) === "brown"), "the red/brown hunk survives");
      const { tr } = rejectHunks(state.doc, state.hunks, "all");
      assert.equal(docToMarkdown(tr.doc), docToMarkdown(start));
    },
  );
});

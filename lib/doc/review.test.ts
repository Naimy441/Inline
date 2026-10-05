import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Transform } from "prosemirror-transform";
import { applyFormat, applyStringEdit, findText } from "./editing";
import { ensureBlockIds } from "./ids";
import { docToMarkdown, markdownToDoc } from "./markdown";
import { schema } from "./schema";
import { acceptHunks, mapHunks, recordAgentChange, rejectHunks, type Hunk } from "./review";

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

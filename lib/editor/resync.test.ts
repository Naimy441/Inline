import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collab, getVersion, sendableSteps } from "prosemirror-collab";
import { EditorState } from "prosemirror-state";

import { markdownToDoc } from "@/lib/doc/markdown";
import { rebaseLocalEdits, unconfirmedEdits } from "@/lib/editor/resync";

const doc = markdownToDoc("First paragraph.\n\nSecond paragraph.");

function stateAt(version: number, base = doc) {
  return EditorState.create({ doc: base, plugins: [collab({ version, clientID: "me" })] });
}

function type(state: EditorState, text: string, pos = 1) {
  return state.apply(state.tr.insertText(text, pos));
}

describe("keeping local edits across a reload", () => {
  it("reports nothing when every edit is confirmed", () => {
    assert.equal(unconfirmedEdits(stateAt(3)), null);
  });

  it("finds the unconfirmed steps and the document they were typed against", () => {
    const typed = type(type(stateAt(3), "A"), "B");
    const local = unconfirmedEdits(typed)!;
    assert.equal(local.steps.length, 2);
    assert.ok(local.base!.eq(doc));
    assert.ok(local.current.eq(typed.doc));
  });

  it("replays typing onto a reload of the same text, even with new version numbers (server restart)", () => {
    const typed = type(stateAt(40), "Hello ");
    const fresh = stateAt(0);
    const { state, unmerged } = rebaseLocalEdits(fresh, unconfirmedEdits(typed));
    assert.equal(unmerged, null);
    assert.equal(state.doc.textContent, typed.doc.textContent);
    // The replayed edits are still waiting to be sent, now against version 0.
    assert.equal(getVersion(state), 0);
    assert.equal(sendableSteps(state)!.steps.length, 1);
  });

  it("keeps edits aside when the server's text moved on, instead of applying them in the wrong place", () => {
    const typed = type(stateAt(5), "Mine ");
    const server = markdownToDoc("Someone rewrote this entirely.");
    const { state, unmerged } = rebaseLocalEdits(stateAt(0, server), unconfirmedEdits(typed));
    assert.ok(state.doc.eq(server));
    assert.ok(unmerged);
    assert.equal(unmerged.steps, 1);
    assert.match(JSON.stringify(unmerged.doc), /Mine First paragraph/);
  });

  it("reports nothing to recover when the server already has the edits", () => {
    const typed = type(stateAt(5), "Saved ");
    const { unmerged } = rebaseLocalEdits(stateAt(6, typed.doc), unconfirmedEdits(typed));
    assert.equal(unmerged, null);
  });
});

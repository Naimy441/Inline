import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collab, getVersion } from "prosemirror-collab";
import { EditorState } from "prosemirror-state";
import type { DecorationSet } from "prosemirror-view";

import { schema } from "@/lib/doc/schema";
import { presencePlugin, setPresence, type Presence } from "./presence";

function doc() {
  return schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text("Normal approximation")));
}

function drawn(version: number, presence: Presence) {
  const plugin = presencePlugin();
  const start = EditorState.create({ doc: doc(), plugins: [collab({ version, clientID: "test" }), plugin] });
  const state = start.apply(setPresence(start.tr, presence));
  const decorations = plugin.props.decorations?.call(plugin, state) as DecorationSet;
  return decorations.find(undefined, undefined, (spec) => spec.key === "agent-caret-editing");
}

describe("presence caret", () => {
  const range = { from: 1, to: 8 };

  it("draws a range recorded at a version the editor has not reached, when the words are already there", () => {
    const start = EditorState.create({ doc: doc(), plugins: [collab({ version: 3, clientID: "test" })] });
    assert.equal(getVersion(start), 3);
    const carets = drawn(3, { status: "editing", label: "Comparing page 1", range, version: 5 });
    assert.equal(carets.length, 1);
  });

  it("does not draw a range that runs past this document", () => {
    const carets = drawn(3, { status: "editing", label: "Comparing page 1", range: { from: 1, to: 500 }, version: 5 });
    assert.equal(carets.length, 0);
  });

  it("does not draw a range from a version this editor has already passed", () => {
    const carets = drawn(3, { status: "editing", label: "Comparing page 1", range, version: 1 });
    assert.equal(carets.length, 0);
  });
});

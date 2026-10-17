import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorState } from "prosemirror-state";

import { schema } from "@/lib/doc/schema";
import { formatSelectionDecorations, formatSelectionKey, formatSelectionPlugin, retainFormattingRange, setFormatSelection } from "./formatSelection";

describe("retainFormattingRange", () => {
  it("keeps the phrase when focusing a control reads no selection", () => {
    const pinned = retainFormattingRange(null, { from: 7, to: 11 });
    assert.deepEqual(pinned, { from: 7, to: 11 });
    assert.equal(retainFormattingRange(pinned, null), pinned);
    assert.deepEqual(retainFormattingRange(pinned, { from: 1, to: 4 }), { from: 1, to: 4 });
  });
});

describe("format selection highlight", () => {
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, schema.text("Alpha beta")),
    schema.nodes.paragraph.create(null, schema.text("Gamma")),
  ]);

  it("paints one phrase, and a range that crosses a paragraph, without touching the rest", () => {
    const beta = formatSelectionDecorations(doc, { from: 7, to: 11 });
    assert.equal(beta.length, 1);
    assert.equal(doc.textBetween(beta[0]!.from, beta[0]!.to), "beta");
    const across = formatSelectionDecorations(doc, { from: 7, to: 15 });
    assert.equal(across.length, 2);
    assert.equal(
      across.map((item) => doc.textBetween(item.from, item.to)).join(""),
      "betaGa",
    );
    assert.equal(formatSelectionDecorations(doc, null).length, 0);
  });

  it("stores the range on the editor state and clears it", () => {
    const plugin = formatSelectionPlugin();
    let state = EditorState.create({ doc, plugins: [plugin] });
    state = state.apply(setFormatSelection(state.tr, { from: 7, to: 11 }));
    assert.deepEqual(formatSelectionKey.getState(state), { from: 7, to: 11 });
    state = state.apply(setFormatSelection(state.tr, null));
    assert.equal(formatSelectionKey.getState(state), null);
  });
});

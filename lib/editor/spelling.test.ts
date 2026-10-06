import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorState } from "prosemirror-state";
import type { DecorationSet } from "prosemirror-view";
import { markdownToDoc } from "../doc/markdown";
import { normalizeWord, setDictionary, spellingPlugin, wordAt } from "./spelling";

function quieted(state: EditorState) {
  const plugin = state.plugins.find((item) => (item as unknown as { key: string }).key.startsWith("spelling"))!;
  const set = plugin.props.decorations!.call(plugin, state) as DecorationSet;
  return set.find().map((decoration) => state.doc.textBetween(decoration.from, decoration.to));
}

describe("the user's dictionary", () => {
  it("stops the browser underlining every occurrence of a dictionary word", () => {
    let state = EditorState.create({ doc: markdownToDoc("Zorblat met Zorblat’s friend.\n\nNo zorblat here? zorblat!"), plugins: [spellingPlugin([])] });
    assert.deepEqual(quieted(state), []);
    state = state.apply(setDictionary(state.tr, [normalizeWord("Zorblat")]));
    assert.deepEqual(quieted(state), ["Zorblat", "zorblat", "zorblat"]);
    // New text is covered as it's typed.
    state = state.apply(state.tr.insertText("Zorblat ", 1));
    assert.equal(quieted(state).length, 4);
  });

  it("finds the word at a position", () => {
    const state = EditorState.create({ doc: markdownToDoc("Hello wonderful world") });
    assert.equal(wordAt(state, 9)?.text, "wonderful");
    assert.equal(normalizeWord("Don’t"), "don't");
  });
});

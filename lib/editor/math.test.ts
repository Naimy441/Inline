import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorState, TextSelection } from "prosemirror-state";
import { docToMarkdown, markdownToDoc } from "@/lib/doc/markdown";
import { insertEquation, mathKey, mathPlugin, mathRanges } from "./math";

function stateFor(markdown: string) {
  return EditorState.create({ doc: markdownToDoc(markdown), plugins: [mathPlugin()] });
}

describe("equations in the editor", () => {
  it("finds each inline equation with its LaTeX", () => {
    const state = stateFor("Area $\\pi r^2$ and $E = mc^2$.");
    assert.deepEqual(
      mathRanges(state.doc).map((range) => range.tex),
      ["\\pi r^2", "E = mc^2"],
    );
  });

  it("shows an equation's source only while the cursor is inside it", () => {
    let state = stateFor("Area $\\pi r^2$ here.");
    const [range] = mathRanges(state.doc);
    assert.equal(mathKey.getState(state)?.editing, null);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, range!.from + 2)));
    assert.equal(mathKey.getState(state)?.editing, range!.from);
    // Typing inside keeps it open; leaving closes it.
    state = state.apply(state.tr.insertText("2", range!.from + 2));
    assert.equal(mathKey.getState(state)?.editing, range!.from);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));
    assert.equal(mathKey.getState(state)?.editing, null);
  });

  it("turns the selection into an inline or a displayed equation", () => {
    let state = stateFor("Write a^2 here");
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 7, 10)));
    insertEquation(false)(state, (tr) => (state = state.apply(tr)));
    assert.equal(docToMarkdown(state.doc), "Write $a^2$ here");

    let empty = stateFor("&nbsp;");
    insertEquation(true)(empty, (tr) => (empty = empty.apply(tr)));
    assert.equal(docToMarkdown(empty.doc), "$$\nx\n$$");
  });
});

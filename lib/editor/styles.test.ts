import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { schema } from "@/lib/doc/schema";
import { BUILTIN_STYLES, styleSheetCss, stylesOf, type ParagraphStyle } from "@/lib/doc/styles";
import { applyStyle, currentStyleId, splitWithNextStyle } from "@/lib/editor/commands";

function run(state: EditorState, command: Command) {
  let next = state;
  const ok = command(state, (tr) => {
    next = state.apply(tr);
  });
  return { ok, state: next };
}

function selectText(state: EditorState, text: string) {
  let from = -1;
  state.doc.descendants((node, pos) => {
    if (from < 0 && node.isText && node.text === text) from = pos;
  });
  assert.ok(from >= 0);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, from + text.length)));
}

const callout: ParagraphStyle = {
  id: "Callout",
  name: "Callout",
  basedOn: "Heading1",
  next: "Normal",
  font: null,
  size: 18,
  spaceBefore: null,
  spaceAfter: 10,
  lineHeight: null,
  color: null,
  italic: true,
};

describe("applying styles", () => {
  it("applies one style in two places, and a later change to the style does not rewrite the paragraphs", () => {
    const sheet = stylesOf({ styles: [callout] });
    let state = EditorState.create({
      doc: schema.nodes.doc!.create(null, [schema.nodes.paragraph!.create(null, schema.text("One")), schema.nodes.paragraph!.create(null, schema.text("Two"))]),
    });
    for (const word of ["One", "Two"]) {
      state = selectText(state, word);
      const applied = run(state, applyStyle("Callout", sheet));
      assert.equal(applied.ok, true);
      state = applied.state;
    }
    assert.deepEqual(
      [state.doc.child(0).attrs.style, state.doc.child(1).attrs.style],
      ["Callout", "Callout"],
    );
    assert.equal(state.doc.child(0).type.name, "heading");
    const before = state.doc.toJSON();
    const beforeCss = styleSheetCss({ styles: [callout], fontFamily: "Arial, Helvetica, sans-serif" });
    const afterCss = styleSheetCss({ styles: [{ ...callout, size: 22 }], fontFamily: "Arial, Helvetica, sans-serif" });
    assert.match(beforeCss, /\[data-style="Callout"\][^{]*\{[^}]*font-size: 18pt/);
    assert.match(afterCss, /\[data-style="Callout"\][^{]*\{[^}]*font-size: 22pt/);
    assert.deepEqual(state.doc.toJSON(), before);
  });

  it("keeps a paragraph's own size when the style is applied", () => {
    const sheet = stylesOf({ styles: [{ ...callout, basedOn: "Normal" }] });
    let state = EditorState.create({
      doc: schema.nodes.doc!.create(null, [schema.nodes.paragraph!.create({ fontSize: 14 }, schema.text("Keep"))]),
    });
    state = selectText(state, "Keep");
    const applied = run(state, applyStyle("Callout", sheet));
    assert.equal(applied.state.doc.firstChild!.type.name, "paragraph");
    assert.equal(applied.state.doc.firstChild!.attrs.style, "Callout");
    assert.equal(applied.state.doc.firstChild!.attrs.fontSize, 14);
  });

  it("Enter gives the new paragraph the style this one names as next", () => {
    let state = EditorState.create({
      doc: schema.nodes.doc!.create(null, [schema.nodes.heading!.create({ level: 1 }, schema.text("Title"))]),
    });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + "Title".length)));
    const split = run(state, splitWithNextStyle(() => BUILTIN_STYLES));
    assert.equal(split.ok, true);
    assert.equal(split.state.doc.child(0).type.name, "heading");
    assert.equal(split.state.doc.child(1).type.name, "paragraph");
    assert.equal(currentStyleId(split.state), "Normal");
  });
});

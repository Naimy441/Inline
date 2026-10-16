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

  it("Enter in the middle of a heading keeps both halves", () => {
    const split = pressEnter(schema.nodes.heading!.create({ level: 1 }, schema.text("Hello world")), 6);
    assert.equal(split.doc.child(0).type.name, "heading");
    assert.equal(split.doc.child(0).textContent, "Hello ");
    assert.equal(split.doc.child(1).type.name, "paragraph");
    assert.equal(split.doc.child(1).textContent, "world");
    assert.equal(split.doc.textContent, "Hello world");
  });
});

describe("splitting a title", () => {
  const title = (text: string) => schema.nodes.title!.create(null, text ? schema.text(text) : undefined);

  it("Enter between the words leaves both in titles", () => {
    const split = pressEnter(title("Hello world"), "Hello ".length);
    assert.equal(split.doc.childCount, 2);
    assert.equal(split.doc.child(0).type.name, "title");
    assert.equal(split.doc.child(0).textContent, "Hello ");
    assert.equal(split.doc.child(1).type.name, "title");
    assert.equal(split.doc.child(1).textContent, "world");
    assert.equal(split.doc.textContent, "Hello world");
  });

  it("Enter at the start adds a title above and keeps the text", () => {
    const split = pressEnter(title("Hello world"), 0);
    assert.equal(split.doc.child(0).type.name, "title");
    assert.equal(split.doc.child(0).textContent, "");
    assert.equal(split.doc.child(1).type.name, "title");
    assert.equal(split.doc.child(1).textContent, "Hello world");
  });

  it("Enter at the end opens a following block", () => {
    const split = pressEnter(title("Hello world"), "Hello world".length);
    assert.equal(split.doc.child(0).type.name, "title");
    assert.equal(split.doc.child(0).textContent, "Hello world");
    assert.equal(split.doc.child(1).type.name, "paragraph");
    assert.equal(split.doc.child(1).textContent, "");
  });

  it("keeps marks on the half that moves down", () => {
    const bold = schema.marks.bold!.create();
    const node = schema.nodes.title!.create(null, [schema.text("Hello "), schema.text("world", [bold])]);
    const split = pressEnter(node, "Hello ".length);
    assert.equal(split.doc.child(1).textContent, "world");
    assert.equal(split.doc.child(1).firstChild!.marks.some((mark) => mark.type === schema.marks.bold), true);
  });

  it("deletes a selection and still keeps the rest", () => {
    let state = EditorState.create({ doc: schema.nodes.doc!.create(null, [title("Hello world")]) });
    const from = 1 + "Hel".length;
    const to = 1 + "Hello wo".length;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
    const split = run(state, splitWithNextStyle(() => BUILTIN_STYLES));
    assert.equal(split.ok, true);
    assert.equal(split.state.doc.child(0).type.name, "title");
    assert.equal(split.state.doc.child(0).textContent, "Hel");
    assert.equal(split.state.doc.child(1).type.name, "title");
    assert.equal(split.state.doc.child(1).textContent, "rld");
    assert.equal(split.state.doc.textContent, "Helrld");
  });
});

function pressEnter(block: import("prosemirror-model").Node, offset: number) {
  let state = EditorState.create({ doc: schema.nodes.doc!.create(null, [block]) });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + offset)));
  const split = run(state, splitWithNextStyle(() => BUILTIN_STYLES));
  assert.equal(split.ok, true);
  return split.state;
}

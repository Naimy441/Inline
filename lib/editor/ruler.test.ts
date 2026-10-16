import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorState, TextSelection } from "prosemirror-state";
import { ensureBlockIds } from "@/lib/doc/ids";
import { docToMarkdown, markdownToDoc } from "@/lib/doc/markdown";
import { attrsForIndents, dragGeometry, indentGeometry, paragraphsInSelection, setParagraphIndents, type IndentGeometry } from "@/lib/editor/ruler";

const PAGE = 6.5;

function close(actual: IndentGeometry, expected: IndentGeometry) {
  assert.ok(Math.abs(actual.first - expected.first) < 0.001, `first ${actual.first} != ${expected.first}`);
  assert.ok(Math.abs(actual.left - expected.left) < 0.001, `left ${actual.left} != ${expected.left}`);
  assert.ok(Math.abs(actual.right - expected.right) < 0.001, `right ${actual.right} != ${expected.right}`);
}

describe("indent geometry", () => {
  it("reads a first-line indent, a hanging indent, and a right indent", () => {
    close(indentGeometry({ indent: 0, textIndent: 0.5 }), { first: 0.5, left: 0, right: 0 });
    close(indentGeometry({ indent: 0, textIndent: -0.5 }), { first: 0, left: 0.5, right: 0 });
    close(indentGeometry({ indent: 2, textIndent: 0.5, rightIndent: 1 }), { first: 1.5, left: 1, right: 1 });
  });

  it("round-trips through paragraph attributes", () => {
    for (const geometry of [
      { first: 0, left: 0, right: 0 },
      { first: 0.5, left: 0, right: 0 },
      { first: 0, left: 0.5, right: 0 },
      { first: 1.5, left: 1, right: 0.25 },
      { first: 0.125, left: 0.5, right: 1 },
    ]) {
      close(indentGeometry(attrsForIndents(geometry)), geometry);
    }
  });

  it("moves the first line, the left indent, both of them, and the right indent", () => {
    close(dragGeometry({ first: 0, left: 0, right: 0 }, "first", 0.5, PAGE, false), { first: 0.5, left: 0, right: 0 });
    close(dragGeometry({ first: 0, left: 0, right: 0 }, "left", 0.5, PAGE, false), { first: 0, left: 0.5, right: 0 });
    close(dragGeometry({ first: 0.5, left: 0, right: 0 }, "margin", 0.5, PAGE, false), { first: 1, left: 0.5, right: 0 });
    close(dragGeometry({ first: 0, left: 0, right: 0 }, "right", -0.5, PAGE, false), { first: 0, left: 0, right: 0.5 });
  });

  it("keeps a little room between the left and right markers", () => {
    const dragged = dragGeometry({ first: 0, left: 0, right: 0 }, "first", PAGE, PAGE, false);
    assert.ok(dragged.first <= PAGE - 0.25);
    const right = dragGeometry({ first: 1, left: 1, right: 0 }, "right", -PAGE, PAGE, false);
    assert.ok(PAGE - right.right >= 1.25);
  });
});

function stateFor(markdown: string, at?: { from: number; to?: number }) {
  const base = EditorState.create({ doc: ensureBlockIds(markdownToDoc(markdown)) });
  if (!at) return base;
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, at.from, at.to ?? at.from)));
}

function run(state: EditorState, geometry: IndentGeometry) {
  let next = state;
  const ok = setParagraphIndents(geometry)(state, (tr) => {
    next = state.apply(tr);
  });
  return { ok, state: next };
}

describe("setParagraphIndents", () => {
  it("changes the paragraph the caret is in and leaves the next one", () => {
    const start = stateFor("First paragraph.\n\nSecond paragraph.", { from: 2 });
    assert.equal(paragraphsInSelection(start).length, 1);
    const { ok, state } = run(start, { first: 0.5, left: 0, right: 0 });
    assert.equal(ok, true);
    assert.equal(state.doc.child(0).attrs.textIndent, 0.5);
    assert.equal(state.doc.child(1).attrs.textIndent, null);
  });

  it("changes every paragraph in the selection", () => {
    const markdown = "First paragraph.\n\nSecond paragraph.\n\nThird.";
    const doc = stateFor(markdown).doc;
    const endOfSecond = doc.child(0).nodeSize + doc.child(1).nodeSize;
    const selected = stateFor(markdown, { from: 1, to: endOfSecond - 1 });
    assert.equal(paragraphsInSelection(selected).length, 2);
    const { state } = run(selected, { first: 0, left: 0.5, right: 1 });
    assert.equal(state.doc.child(0).attrs.textIndent, -0.5);
    assert.equal(state.doc.child(0).attrs.rightIndent, 1);
    assert.equal(state.doc.child(1).attrs.textIndent, -0.5);
    assert.equal(state.doc.child(2).attrs.rightIndent, null);
  });
});

describe("markdown indents", () => {
  it("keeps a fractional indent, a first line, and a right indent", () => {
    const markdown = "Indented {indent=1.25 first-line=0.125 right=0.5}";
    const doc = markdownToDoc(markdown);
    assert.equal(doc.child(0).attrs.indent, 1.25);
    assert.equal(doc.child(0).attrs.textIndent, 0.125);
    assert.equal(doc.child(0).attrs.rightIndent, 0.5);
    assert.match(docToMarkdown(doc), /indent=1\.25/);
    assert.match(docToMarkdown(doc), /first-line=0\.125/);
    assert.match(docToMarkdown(doc), /right=0\.5/);
  });
});

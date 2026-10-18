import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { schema } from "@/lib/doc/schema";
import { keepVisibleSelection, noteArrowLag, rangeTouchingCaret, retainHeldSelection, syncDomSelection, textSelectionNear } from "./domSync";

describe("retainHeldSelection", () => {
  it("keeps a range the next toolbar press can no longer see, until the caret moves", () => {
    const held = retainHeldSelection(null, { from: 1, to: 12 }, { from: 12, empty: true });
    assert.deepEqual(held, { from: 1, to: 12, anchor: 12 });
    assert.equal(retainHeldSelection(held, null, { from: 12, empty: true }), held);
    assert.equal(retainHeldSelection(held, null, { from: 1, empty: true }), held);
    assert.equal(retainHeldSelection(held, null, { from: 4, empty: true }), null);
  });
});

describe("rangeTouchingCaret", () => {
  it("keeps a phrase when the caret is on either end", () => {
    const range = { from: 1, to: 12 };
    assert.equal(rangeTouchingCaret(range, 1), range);
    assert.equal(rangeTouchingCaret(range, 12), range);
    assert.equal(rangeTouchingCaret(range, 4), null);
    assert.equal(rangeTouchingCaret(null, 1), null);
    assert.equal(rangeTouchingCaret({ from: 3, to: 3 }, 3), null);
  });
});

describe("textSelectionNear", () => {
  it("turns a caret between blocks into the nearest text caret, not a later word", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, schema.text("Start here.")),
      schema.nodes.paragraph.create(null, schema.text("HelloSecond page.")),
    ]);
    const boundary = doc.child(0).nodeSize;
    const caret = textSelectionNear(doc, boundary, boundary);
    assert.ok(caret);
    assert.equal(caret.empty, true);
    assert.equal(caret.$from.parent.inlineContent, true);
    assert.equal(doc.textBetween(0, caret.from), "Start here.");
  });

  it("keeps a Shift+End range when the moving end is past the block", () => {
    const text = "A sentence to select.";
    const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text(text)));
    const range = textSelectionNear(doc, 1, doc.content.size);
    assert.ok(range);
    assert.equal(doc.textBetween(range.from, range.to), text);
  });
});

describe("keepVisibleSelection", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const previous = new Map<string, unknown>();

  before(() => {
    const win = dom.window;
    const host = globalThis as typeof globalThis & Record<string, unknown>;
    for (const key of ["window", "document", "HTMLElement", "Element", "Node", "DocumentFragment", "getComputedStyle"]) {
      previous.set(key, host[key]);
      const value = (win as unknown as Record<string, unknown>)[key];
      try {
        host[key] = value;
      } catch {
        Object.defineProperty(host, key, { configurable: true, writable: true, value });
      }
    }
  });

  after(() => {
    const host = globalThis as typeof globalThis & Record<string, unknown>;
    for (const [key, value] of previous) {
      try {
        if (value === undefined) delete host[key];
        else host[key] = value;
      } catch {
        Object.defineProperty(host, key, { configurable: true, writable: true, value });
      }
    }
  });

  function mount(text: string) {
    const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text(text)));
    const mountPoint = dom.window.document.createElement("div");
    dom.window.document.body.append(mountPoint);
    const view = new EditorView(mountPoint, { state: EditorState.create({ doc }) });
    const node = view.dom.querySelector("p")!.firstChild!;
    return { view, node, destroy: () => view.destroy() };
  }

  it("keeps a range the page shows when a caret-only pass would paint it away", () => {
    const text = "A sentence to select.";
    const { view, node, destroy } = mount(text);
    try {
      assert.equal(view.state.selection.empty, true);
      dom.window.document.getSelection = () =>
        ({
          anchorNode: node,
          anchorOffset: 0,
          focusNode: node,
          focusOffset: text.length,
        }) as unknown as Selection;
      const tr = keepVisibleSelection(view, view.state.tr.setMeta("spell", true));
      assert.equal(tr.selection.empty, false);
      assert.equal(tr.selection.from, 1);
      assert.equal(tr.selection.to, 1 + text.length);
    } finally {
      destroy();
    }
  });

  it("keeps a caret the page shows when a layout pass would paint where typing finished", () => {
    const text = "HelloSecond page.";
    const { view, node, destroy } = mount(text);
    try {
      const typed = TextSelection.create(view.state.doc, 1 + "Hello".length);
      view.dispatch(view.state.tr.setSelection(typed));
      dom.window.document.getSelection = () =>
        ({
          anchorNode: node,
          anchorOffset: 0,
          focusNode: node,
          focusOffset: 0,
        }) as unknown as Selection;
      const tr = keepVisibleSelection(view, view.state.tr.setMeta("spell", true));
      assert.equal(tr.selection.empty, true);
      assert.equal(tr.selection.from, 1);
      syncDomSelection(view);
      assert.equal(view.state.selection.empty, true);
      assert.equal(view.state.selection.from, 1);
      // The next key already moved the caret. The page still shows the previous one,
      // including a second pass after the first one refused to follow it.
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1 + "Hello".length)));
      noteArrowLag(view, view.state.doc, 1);
      syncDomSelection(view);
      syncDomSelection(view);
      assert.equal(view.state.selection.from, 1 + "Hello".length);
      // Home: state is still where typing finished, and the page shows the line start.
      dom.window.document.getSelection = () =>
        ({
          anchorNode: node,
          anchorOffset: "Hello".length,
          focusNode: node,
          focusOffset: "Hello".length,
        }) as unknown as Selection;
      syncDomSelection(view);
      assert.equal(view.state.selection.from, 1 + "Hello".length);
      dom.window.document.getSelection = () =>
        ({
          anchorNode: node,
          anchorOffset: 0,
          focusNode: node,
          focusOffset: 0,
        }) as unknown as Selection;
      syncDomSelection(view);
      assert.equal(view.state.selection.from, 1);
      // The page paints the caret from before Home. That is behind, not a new move.
      dom.window.document.getSelection = () =>
        ({
          anchorNode: node,
          anchorOffset: "Hello".length,
          focusNode: node,
          focusOffset: "Hello".length,
        }) as unknown as Selection;
      syncDomSelection(view);
      assert.equal(view.state.selection.from, 1);
    } finally {
      destroy();
    }
  });

  it("adopts a range the page shows so a later flush cannot paint the caret", () => {
    const text = "Hello world";
    const { view, node, destroy } = mount(text);
    try {
      assert.equal(view.state.selection.empty, true);
      dom.window.document.getSelection = () =>
        ({
          anchorNode: node,
          anchorOffset: 0,
          focusNode: node,
          focusOffset: text.length,
        }) as unknown as Selection;
      syncDomSelection(view);
      assert.equal(view.state.selection.empty, false);
      assert.equal(view.state.selection.from, 1);
      assert.equal(view.state.selection.to, 1 + text.length);
      // A selection the editor already has (a picture, cells, or a shorter phrase) stays.
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
      syncDomSelection(view);
      assert.equal(view.state.selection.from, 1);
      assert.equal(view.state.selection.to, 3);
    } finally {
      destroy();
    }
  });

  it("leaves a transaction that edits the document or sets its own selection", () => {
    const { view, node, destroy } = mount("Hello");
    try {
      dom.window.document.getSelection = () =>
        ({
          anchorNode: node,
          anchorOffset: 0,
          focusNode: node,
          focusOffset: 5,
        }) as unknown as Selection;
      const edited = keepVisibleSelection(view, view.state.tr.insertText("!"));
      assert.equal(edited.selection.empty, true);
      const chosen = keepVisibleSelection(view, view.state.tr.setSelection(view.state.selection));
      assert.equal(chosen.selectionSet, true);
      assert.equal(chosen.selection.empty, true);
    } finally {
      destroy();
    }
  });
});

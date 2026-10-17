import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { schema } from "@/lib/doc/schema";
import { keepVisibleSelection, retainHeldSelection } from "./domSync";

describe("retainHeldSelection", () => {
  it("keeps a range the next toolbar press can no longer see, until the caret moves", () => {
    const held = retainHeldSelection(null, { from: 1, to: 12 }, { from: 12, empty: true });
    assert.deepEqual(held, { from: 1, to: 12, anchor: 12 });
    assert.equal(retainHeldSelection(held, null, { from: 12, empty: true }), held);
    assert.equal(retainHeldSelection(held, null, { from: 1, empty: true }), held);
    assert.equal(retainHeldSelection(held, null, { from: 4, empty: true }), null);
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

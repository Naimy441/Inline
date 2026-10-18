import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";

import { schema } from "@/lib/doc/schema";
import { commitDomCaret, keepVisibleSelection, noteCaretGesture, rangeTouchingCaret, readDomSelection, resetCaretGesture, retainHeldSelection, selectionExtends, syncDomSelection, textSelectionNear } from "./domSync";
import { presenceKey } from "./presence";

describe("retainHeldSelection", () => {
  it("keeps a range the next toolbar press can no longer see, until the caret moves", () => {
    const held = retainHeldSelection(null, { from: 1, to: 12 }, { from: 12, empty: true });
    assert.deepEqual(held, { from: 1, to: 12, anchor: 12 });
    assert.equal(retainHeldSelection(held, null, { from: 12, empty: true }), held);
    assert.equal(retainHeldSelection(held, null, { from: 1, empty: true }), held);
    assert.equal(retainHeldSelection(held, null, { from: 4, empty: true }), null);
  });
});

describe("selectionExtends", () => {
  it("is a longer phrase with the same anchor", () => {
    const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text("umbrella today.")));
    const end = doc.content.size - 1;
    const one = TextSelection.create(doc, end, end - 1);
    const phrase = TextSelection.create(doc, end, 1);
    assert.equal(selectionExtends(one, phrase), true);
    assert.equal(selectionExtends(phrase, one), false);
    assert.equal(selectionExtends(one, TextSelection.create(doc, end - 1, end - 2)), false);
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
    } finally {
      destroy();
    }
  });

  it("keeps a phrase when the page drops the highlight without a key or a click", () => {
    const text = "A sentence to select.";
    const { view, node, destroy } = mount(text);
    try {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 1 + text.length)));
      view.dom.focus();
      showCaret(node, 0);
      resetCaretGesture();
      commitDomCaret(view);
      assert.equal(view.state.selection.empty, false);
      assert.equal(view.state.selection.from, 1);
      assert.equal(view.state.selection.to, 1 + text.length);
    } finally {
      destroy();
      resetCaretGesture();
    }
  });

  it("adopts a caret the reader just placed over a phrase", () => {
    const text = "A sentence to select.";
    const { view, node, destroy } = mount(text);
    try {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 1 + text.length)));
      view.dom.focus();
      showCaret(node, 0);
      noteCaretGesture();
      commitDomCaret(view);
      assert.equal(view.state.selection.empty, true);
      assert.equal(view.state.selection.from, 1);
    } finally {
      destroy();
      resetCaretGesture();
    }
  });

  it("does not adopt a page range onto the update that shows where Claude is working", () => {
    const text = "Hello world";
    const { view, node, destroy } = mount(text);
    try {
      dom.window.document.getSelection = () =>
        ({
          anchorNode: node,
          anchorOffset: 0,
          focusNode: node,
          focusOffset: text.length,
        }) as unknown as Selection;
      const tr = keepVisibleSelection(view, view.state.tr.setMeta(presenceKey, { presence: null }));
      assert.equal(tr.selection.empty, true);
      assert.equal(tr.getMeta(presenceKey) !== undefined, true);
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

  it("grows a Shift+Arrow selection instead of painting the first character back", () => {
    const text = "umbrella today.";
    const { view, node, destroy } = mount(text);
    try {
      const end = 1 + text.length;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end, end - 1)));
      dom.window.document.getSelection = () =>
        ({
          anchorNode: node,
          anchorOffset: text.length,
          focusNode: node,
          focusOffset: 0,
        }) as unknown as Selection;
      view.dom.focus();
      const flushed = keepVisibleSelection(view, view.state.tr.setMeta("page", true).setMeta("addToHistory", false));
      assert.equal(view.state.doc.textBetween(flushed.selection.from, flushed.selection.to), text);
      assert.equal(flushed.selection.anchor, end);
    } finally {
      destroy();
    }
  });

  it("does not put a phrase back after End collapsed it", () => {
    const text = "SHOUT THIS";
    const { view, node, destroy } = mount(text);
    try {
      const end = 1 + text.length;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
      dom.window.document.getSelection = () =>
        ({
          anchorNode: node,
          anchorOffset: 0,
          focusNode: node,
          focusOffset: text.length,
        }) as unknown as Selection;
      noteCaretGesture();
      const flushed = keepVisibleSelection(view, view.state.tr.setMeta("page", true).setMeta("addToHistory", false));
      assert.equal(flushed.selection.empty, true);
      assert.equal(flushed.selection.from, end);
      resetCaretGesture();
      noteCaretGesture(true);
      const extended = keepVisibleSelection(view, view.state.tr.setMeta("page", true).setMeta("addToHistory", false));
      assert.equal(view.state.doc.textBetween(extended.selection.from, extended.selection.to), text);
    } finally {
      destroy();
      resetCaretGesture();
    }
  });

  it("does not adopt a range that does not touch the caret", () => {
    const text = "umbrella today.";
    const { view, node, destroy } = mount(text);
    try {
      const end = 1 + text.length;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
      const a = text.lastIndexOf("a");
      dom.window.document.getSelection = () =>
        ({
          anchorNode: node,
          anchorOffset: a,
          focusNode: node,
          focusOffset: a + 1,
        }) as unknown as Selection;
      const flushed = keepVisibleSelection(view, view.state.tr.setMeta("page", true).setMeta("addToHistory", false));
      assert.equal(flushed.selection.empty, true);
      assert.equal(flushed.selection.from, end);
    } finally {
      destroy();
    }
  });

  it("reads a Shift+Home range that ends on the editor element, and a flush keeps it", () => {
    const text = "Hello world";
    const { view, node, destroy } = mount(text);
    try {
      // Chrome reports Shift+Home with one end on the contenteditable itself.
      // contains() is false for that node, so the phrase used to be invisible.
      dom.window.document.getSelection = () =>
        ({
          anchorNode: node,
          anchorOffset: text.length,
          focusNode: view.dom,
          focusOffset: 0,
        }) as unknown as Selection;
      const read = readDomSelection(view);
      assert.ok(read);
      assert.equal(read.empty, false);
      assert.equal(view.state.doc.textBetween(read.from, read.to), text);
      const flushed = keepVisibleSelection(view, view.state.tr.setMeta("page", true).setMeta("addToHistory", false));
      assert.equal(view.state.doc.textBetween(flushed.selection.from, flushed.selection.to), text);
    } finally {
      destroy();
    }
  });

  it("clamps a Shift+Home end that sits just outside the editor", () => {
    const text = "Hello world";
    const { view, node, destroy } = mount(text);
    try {
      dom.window.document.getSelection = () =>
        ({
          anchorNode: node,
          anchorOffset: text.length,
          focusNode: dom.window.document.body,
          focusOffset: 0,
        }) as unknown as Selection;
      const read = readDomSelection(view);
      assert.ok(read);
      assert.equal(view.state.doc.textBetween(read.from, read.to), text);
      dom.window.document.getSelection = () =>
        ({
          anchorNode: node,
          anchorOffset: 0,
          focusNode: dom.window.document.body,
          focusOffset: 1,
        }) as unknown as Selection;
      const end = readDomSelection(view);
      assert.ok(end);
      assert.equal(view.state.doc.textBetween(end.from, end.to), text);
    } finally {
      destroy();
    }
  });

  function showCaret(node: ChildNode, offset: number) {
    dom.window.document.getSelection = () =>
      ({
        anchorNode: node,
        anchorOffset: offset,
        focusNode: node,
        focusOffset: offset,
      }) as unknown as Selection;
  }

  /**
   * Home, End, an arrow, and a click in the margin each leave the caret on the
   * page before the editor has recorded it. A layout pass, and a later pass
   * that still carries the old caret, must not put that caret back.
   */
  function gesture(name: string, text: string, fromOffset: number, toOffset: number) {
    it(`${name}: commits the caret before a layout pass, and a later pass cannot restore the old one`, () => {
      const { view, node, destroy } = mount(text);
      try {
        const previous = 1 + fromOffset;
        const next = 1 + toOffset;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, previous)));
        const stale = view.state.tr.setMeta("spell", true);
        showCaret(node, toOffset);
        let flushed: number | null = null;
        const observer = (view as unknown as { domObserver: { flush(): void } }).domObserver;
        const originalFlush = observer.flush;
        observer.flush = () => {
          flushed = view.state.selection.from;
        };
        view.dom.focus();
        syncDomSelection(view);
        observer.flush = originalFlush;
        assert.equal(view.state.selection.empty, true);
        assert.equal(view.state.selection.from, next);
        assert.equal(flushed, next);
        const painted = keepVisibleSelection(view, view.state.tr.setMeta("page", true));
        view.dispatch(painted);
        assert.equal(view.state.selection.from, next);
        const later = keepVisibleSelection(view, stale);
        view.dispatch(later);
        assert.equal(view.state.selection.from, next);
        const again = keepVisibleSelection(
          view,
          EditorState.create({ doc: view.state.doc, selection: TextSelection.create(view.state.doc, previous) }).tr.setMeta("spell", true),
        );
        view.dispatch(again);
        assert.equal(view.state.selection.from, next);
      } finally {
        destroy();
      }
    });
  }

  gesture("Home", "Start here.Hello", "Start here.Hello".length, 0);
  gesture("End", "Start here.Hello", 0, "Start here.Hello".length);
  gesture("ArrowLeft", "Start here.Hello", "Start here.Hello".length, "Start here.".length);
  gesture("a margin click", "Start here.Hello", "Start here.Hello".length, "Start ".length);

  it("a later gesture replaces the caret a pass already committed", () => {
    const text = "Start here.Hello";
    const { view, node, destroy } = mount(text);
    try {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1 + text.length)));
      showCaret(node, 0);
      syncDomSelection(view);
      assert.equal(view.state.selection.from, 1);
      showCaret(node, text.length);
      syncDomSelection(view);
      assert.equal(view.state.selection.from, 1 + text.length);
      const stale = keepVisibleSelection(view, EditorState.create({ doc: view.state.doc, selection: TextSelection.create(view.state.doc, 1) }).tr.setMeta("page", true));
      view.dispatch(stale);
      assert.equal(view.state.selection.from, 1 + text.length);
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

  it("reads a caret in a page gap as the text beside that gap", () => {
    const text = schema.nodes.paragraph.create(null, schema.text("HelloSecond page."));
    const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, schema.text("Start here.")), text]);
    const gapPos = doc.child(0).nodeSize;
    const plugin = new Plugin({
      props: {
        decorations(state) {
          return DecorationSet.create(state.doc, [
            Decoration.widget(gapPos, () => {
              const gap = dom.window.document.createElement("div");
              gap.className = "page-gap";
              gap.append(dom.window.document.createElement("span"));
              return gap;
            }, { side: -1, ignoreSelection: true, key: "gap" }),
          ]);
        },
      },
    });
    const mountPoint = dom.window.document.createElement("div");
    dom.window.document.body.append(mountPoint);
    const view = new EditorView(mountPoint, { state: EditorState.create({ doc, plugins: [plugin] }) });
    const typed = 1 + doc.child(0).nodeSize + "Hello".length;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, typed)));
    try {
      const gap = view.dom.querySelector(".page-gap")!;
      const anchor = gap.firstChild!;
      dom.window.document.getSelection = () =>
        ({
          anchorNode: anchor,
          anchorOffset: 0,
          focusNode: anchor,
          focusOffset: 0,
          rangeCount: 1,
        }) as unknown as Selection;
      const read = readDomSelection(view);
      assert.ok(read, "a page-gap caret should still be a text position");
      assert.equal(read.empty, true);
      assert.notEqual(read.from, typed);
      assert.equal(view.state.doc.textBetween(0, read.from), "Start here.");
    } finally {
      view.destroy();
    }
  });
});

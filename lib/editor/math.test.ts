import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { baseKeymap } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { ensureBlockIds } from "@/lib/doc/ids";
import { docToMarkdown, markdownToDoc } from "@/lib/doc/markdown";
import { MATH_LANGUAGE, schema } from "@/lib/doc/schema";
import { compileCanvas } from "@/lib/canvas/compiler";
import { codeBlockView, insertEquation, mathKey, mathPlugin, mathRanges } from "./math";
import { editorPlugins } from "./setup";

function stateFor(markdown: string) {
  return EditorState.create({ doc: markdownToDoc(markdown), plugins: [mathPlugin()] });
}

function typingState(markdown: string) {
  return EditorState.create({
    doc: ensureBlockIds(markdownToDoc(markdown)),
    plugins: editorPlugins({
      version: 0,
      clientID: "test",
      review: { review: () => undefined },
      onActivateComment: () => undefined,
      geometry: () => ({ pageHeight: 1056, marginTop: 96, marginBottom: 96, gap: 24 }),
    }),
  });
}

/** Type one character at a time, through every input handler, as the editor does. */
function type(state: EditorState, text: string) {
  const handlers = state.plugins.map((plugin) => plugin.props.handleTextInput).filter((fn): fn is NonNullable<typeof fn> => Boolean(fn));
  for (const ch of text) {
    const view = {
      composing: false,
      state,
      dispatch(tr: Transaction) {
        view.state = state.apply(tr);
      },
    };
    const { from, to } = view.state.selection;
    let handled = false;
    for (const handle of handlers) {
      if (handle.call(null as never, view as never, from, to, ch, () => view.state.tr)) {
        handled = true;
        break;
      }
    }
    if (!handled) view.dispatch(view.state.tr.insertText(ch));
    state = view.state;
  }
  return state;
}

function displayTexts(state: EditorState) {
  const texts: string[] = [];
  state.doc.descendants((node) => {
    if (node.type === schema.nodes.code_block && node.attrs.language === MATH_LANGUAGE) texts.push(node.textContent);
  });
  return texts;
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

  it("accepts a whole inline expression typed as $...$", () => {
    const typed = type(typingState(""), "Energy is $E=mc^2$ today.");
    assert.deepEqual(mathRanges(typed.doc).map((range) => range.tex), ["E=mc^2"]);
    assert.equal(docToMarkdown(typed.doc), "Energy is $E=mc^2$ today.");
    const prices = type(typingState(""), "prices like $5 and $10 stay text.");
    assert.equal(mathRanges(prices.doc).length, 0);
    assert.match(prices.doc.textContent, /\$5 and \$10/);
  });

  it("keeps every character typed into an inline equation", () => {
    let state = typingState("");
    insertEquation(false)(state, (tr) => (state = state.apply(tr)));
    state = type(state, "E=mc^2");
    assert.deepEqual(mathRanges(state.doc).map((range) => range.tex), ["E=mc^2"]);
  });

  it("opens a displayed equation from $$ and from $$...$$", () => {
    const opened = type(typingState(""), "$$ \\frac{a}{b}");
    assert.deepEqual(displayTexts(opened), ["\\frac{a}{b}"]);

    const closed = type(typingState(""), "$$E=mc^2$$");
    assert.deepEqual(displayTexts(closed), ["E=mc^2"]);

    const displayed = type(typingState(""), "See $$E=mc^2$$ next.");
    assert.deepEqual(displayTexts(displayed), ["E=mc^2"]);
    assert.match(displayed.doc.textContent, /See/);
    assert.match(displayed.doc.textContent, /next/);
    assert.equal(mathRanges(displayed.doc).length, 0);
  });
});

describe("deleting a displayed equation", () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const previous = new Map<string, unknown>();

  before(() => {
    const win = dom.window;
    const host = globalThis as typeof globalThis & Record<string, unknown>;
    for (const key of ["window", "document", "HTMLElement", "Element", "Node", "DocumentFragment", "getComputedStyle", "navigator"]) {
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

  it("puts the authored class on a displayed equation", () => {
    const doc = compileCanvas('<Canvas><Math display id="eq" class="eqbox">a+b</Math></Canvas>', ".eqbox { border-top: 1px solid #111111; padding: 8px 0; margin: 12px 0; background-color: #fafafa }");
    const mountPoint = document.createElement("div");
    document.body.append(mountPoint);
    const view = new EditorView(mountPoint, {
      state: EditorState.create({ doc }),
      nodeViews: { code_block: codeBlockView },
    });
    const block = view.dom.querySelector(".math-block");
    assert.ok(block?.classList.contains("eqbox"));
    assert.equal((block as HTMLElement).dataset.id, "eq");
    view.destroy();
    mountPoint.remove();
  });

  function mount(markdown: string) {
    const mountPoint = document.createElement("div");
    document.body.append(mountPoint);
    const view = new EditorView(mountPoint, {
      state: EditorState.create({ doc: markdownToDoc(markdown), plugins: [mathPlugin(), keymap(baseKeymap)] }),
    });
    return view;
  }

  function press(view: EditorView, key: string) {
    const event = { key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false } as KeyboardEvent;
    for (const plugin of view.state.plugins) {
      const handle = plugin.props.handleKeyDown;
      if (handle?.call(plugin, view, event)) return;
    }
    baseKeymap[key]?.(view.state, view.dispatch.bind(view), view);
  }

  function blockPos(view: EditorView) {
    let found = -1;
    view.state.doc.descendants((node, pos) => {
      if (found >= 0) return false;
      if (node.type === schema.nodes.code_block && node.attrs.language === MATH_LANGUAGE) {
        found = pos;
        return false;
      }
      return true;
    });
    return found;
  }

  it("clears to blank, then an extra Backspace or Delete removes the node", () => {
    for (const key of ["Backspace", "Delete"] as const) {
      const view = mount("$$\nab\n$$");
      try {
        const pos = blockPos(view);
        const node = view.state.doc.nodeAt(pos)!;
        const caret = key === "Backspace" ? pos + 1 + node.content.size : pos + 1;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, caret)));
        press(view, key);
        press(view, key);
        assert.deepEqual(displayTexts(view.state), [""]);
        press(view, key);
        assert.deepEqual(displayTexts(view.state), []);
        assert.equal(view.state.doc.child(0).type.name, "paragraph");
      } finally {
        view.destroy();
      }
    }
  });

  it("removes a displayed equation from the paragraph before it and the one after it", () => {
    const markdown = "Before\n\n$$\nE=mc^2\n$$\n\nAfter";
    const fromBefore = mount(markdown);
    try {
      const before = fromBefore.state.doc.child(0);
      fromBefore.dispatch(fromBefore.state.tr.setSelection(TextSelection.create(fromBefore.state.doc, 1 + before.content.size)));
      press(fromBefore, "Delete");
      assert.deepEqual(displayTexts(fromBefore.state), []);
      assert.equal(fromBefore.state.doc.textContent, "BeforeAfter");
      assert.equal(fromBefore.state.selection.$from.parent.textContent, "Before");
    } finally {
      fromBefore.destroy();
    }

    const fromAfter = mount(markdown);
    try {
      let after = -1;
      fromAfter.state.doc.forEach((node, offset) => {
        if (node.textContent === "After") after = offset + 1;
      });
      fromAfter.dispatch(fromAfter.state.tr.setSelection(TextSelection.create(fromAfter.state.doc, after)));
      press(fromAfter, "Backspace");
      assert.deepEqual(displayTexts(fromAfter.state), []);
      assert.equal(fromAfter.state.doc.textContent, "BeforeAfter");
      assert.equal(fromAfter.state.selection.$from.parent.textContent, "After");
    } finally {
      fromAfter.destroy();
    }
  });
});

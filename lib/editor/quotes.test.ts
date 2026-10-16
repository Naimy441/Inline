import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { ensureBlockIds } from "../doc/ids";
import { markdownToDoc } from "../doc/markdown";
import { schema } from "../doc/schema";
import { editorPlugins } from "./setup";

function stateFor(markdown: string, options: { substitutions?: () => boolean } = {}) {
  return EditorState.create({
    doc: ensureBlockIds(markdownToDoc(markdown)),
    plugins: editorPlugins({
      version: 0,
      clientID: "test",
      review: { review: () => undefined },
      onActivateComment: () => undefined,
      geometry: () => ({ pageHeight: 1056, marginTop: 96, marginBottom: 96, gap: 24 }),
      ...options,
    }),
  });
}

/** Type through the input-rules plugin, as the editor does for each key. */
function type(state: EditorState, text: string, at?: number) {
  const plugin = state.plugins.find((item) => (item.spec as { isInputRules?: boolean }).isInputRules);
  assert.ok(plugin?.props.handleTextInput);
  if (at != null) state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));
  const handle = plugin.props.handleTextInput;
  for (const ch of text) {
    const view = {
      composing: false,
      state,
      dispatch(tr: Transaction) {
        view.state = state.apply(tr);
      },
    };
    const { from, to } = view.state.selection;
    if (!handle.call(plugin, view as never, from, to, ch, () => view.state.tr)) view.dispatch(view.state.tr.insertText(ch));
    state = view.state;
  }
  return state;
}

describe("smart quotes", () => {
  it("opens at the start of a word and closes at the end", () => {
    const state = type(stateFor(""), '"She said "hello" today."');
    assert.equal(state.doc.textContent, "“She said “hello” today.”");
  });

  it("opens after a space and closes after a letter", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", { id: "p1" }, schema.text("Hello "))]);
    const state = type(EditorState.create({ doc, plugins: stateFor("").plugins }), '"world"', doc.content.size - 1);
    assert.equal(state.doc.textContent, "Hello “world”");
  });

  it("nests a single quote inside a double quote", () => {
    const state = type(stateFor(""), "\"She said 'hi'\"");
    assert.equal(state.doc.textContent, "“She said ‘hi’”");
  });

  it("uses an apostrophe inside a word and an opening quote before one", () => {
    const state = type(stateFor(""), "don't say 'hello'");
    assert.equal(state.doc.textContent, "don’t say ‘hello’");
  });

  it("opens a quote on the next line after a line break", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", { id: "p1" }, [schema.text("Hello"), schema.nodes.hard_break!.create()])]);
    let state = EditorState.create({
      doc,
      plugins: stateFor("").plugins,
    });
    state = type(state, '"Next"', doc.content.size - 1);
    assert.equal(state.doc.textContent, "Hello“Next”");
  });

  it("leaves quotes straight inside a code block", () => {
    const doc = schema.node("doc", null, [schema.node("code_block", { id: "c1" }, schema.text("x = "))]);
    let state = EditorState.create({ doc, plugins: stateFor("").plugins });
    state = type(state, '"a"', doc.content.size - 1);
    assert.equal(state.doc.textContent, 'x = "a"');
  });

  it("leaves quotes straight inside inline code", () => {
    const code = schema.marks.code.create();
    const doc = schema.node("doc", null, [schema.node("paragraph", { id: "p1" }, [schema.text("fn(", [code])])]);
    let state = EditorState.create({ doc, plugins: stateFor("").plugins });
    state = type(state, '"a"', doc.content.size - 1);
    assert.equal(state.doc.textContent, 'fn("a"');
    state.doc.descendants((node) => {
      if (node.isText) assert.ok(node.marks.some((mark) => mark.type === schema.marks.code));
    });
  });

  it("leaves quotes straight when the code mark is stored for the next character", () => {
    let state = stateFor("");
    const at = state.doc.content.size - 1;
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)).setStoredMarks([schema.marks.code.create()]));
    state = type(state, '"a"');
    assert.equal(state.doc.textContent, '"a"');
  });

  it("does not rewrite straight quotes already in the document", () => {
    const state = stateFor('She said "hello" already.');
    assert.equal(state.doc.textContent, 'She said "hello" already.');
  });

  it("stays straight when automatic substitutions are off", () => {
    const state = type(stateFor("", { substitutions: () => false }), '"hello"');
    assert.equal(state.doc.textContent, '"hello"');
  });
});

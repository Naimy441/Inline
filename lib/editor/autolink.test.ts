import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitBlock } from "prosemirror-commands";
import { EditorState, TextSelection } from "prosemirror-state";
import { ensureBlockIds } from "../doc/ids";
import { markdownToDoc } from "../doc/markdown";
import { schema } from "../doc/schema";
import { autolinkAtEnd } from "./autolink";
import { editorPlugins } from "./setup";

function stateFor(markdown: string) {
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

function endOfText(state: EditorState) {
  let pos = 1;
  state.doc.descendants((node, at) => {
    if (node.isText) pos = at + node.nodeSize;
  });
  return pos;
}

function placeAtEnd(state: EditorState) {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, endOfText(state))));
}

function type(state: EditorState, text: string) {
  let next = placeAtEnd(state);
  for (const ch of text) next = next.apply(next.tr.insertText(ch));
  return next;
}

function pressEnter(state: EditorState) {
  const placed = placeAtEnd(state);
  let next = placed;
  const ok = splitBlock(placed, (tr) => {
    next = placed.apply(tr);
  });
  assert.equal(ok, true);
  return next;
}

function hrefOf(state: EditorState, text: string) {
  let href: string | null = null;
  state.doc.descendants((node) => {
    if (node.isText && node.text?.includes(text)) {
      const sliceFrom = node.text.indexOf(text);
      const mark = schema.marks.link!.isInSet(node.marks);
      if (mark && sliceFrom >= 0) href = mark.attrs.href as string;
    }
  });
  return href;
}

function hasMark(state: EditorState, text: string, name: string) {
  let found = false;
  state.doc.descendants((node) => {
    if (node.isText && node.text?.includes(text) && node.marks.some((mark) => mark.type.name === name)) found = true;
  });
  return found;
}

describe("autolink", () => {
  it("recognizes http(s) and www links, not ordinary words", () => {
    assert.equal(autolinkAtEnd("https://example.com")?.href, "https://example.com");
    assert.equal(autolinkAtEnd("See http://example.com/a?q=1")?.text, "http://example.com/a?q=1");
    assert.equal(autolinkAtEnd("www.example.com/docs")?.href, "https://www.example.com/docs");
    assert.equal(autolinkAtEnd("https://example.com.")?.text, "https://example.com");
    assert.equal(autolinkAtEnd("hello"), null);
    assert.equal(autolinkAtEnd("example.com"), null);
    assert.equal(autolinkAtEnd("www"), null);
    assert.equal(autolinkAtEnd("www.example"), null);
    assert.equal(autolinkAtEnd("https://"), null);
  });

  it("links a typed http(s) or www URL when Space or Enter follows it", () => {
    const spaced = type(stateFor(""), "See https://example.com ");
    assert.equal(hrefOf(spaced, "https://example.com"), "https://example.com");
    assert.equal(spaced.doc.textContent, "See https://example.com ");

    const entered = pressEnter(type(stateFor(""), "http://example.com/path"));
    assert.equal(hrefOf(entered, "http://example.com/path"), "http://example.com/path");

    const www = pressEnter(type(stateFor(""), "Go to www.example.com"));
    assert.equal(hrefOf(www, "www.example.com"), "https://www.example.com");
    assert.equal(www.doc.textContent.includes("www.example.com"), true);
  });

  it("does not link ordinary words, bare hosts, code, or equations", () => {
    assert.equal(hrefOf(type(stateFor(""), "hello "), "hello"), null);
    assert.equal(hrefOf(type(stateFor(""), "example.com "), "example.com"), null);
    assert.equal(hrefOf(pressEnter(stateFor("example.com")), "example.com"), null);

    const code = schema.node("doc", null, [schema.node("paragraph", { id: "p" }, [schema.text("https://example.com", [schema.mark("code")])])]);
    const coded = type(EditorState.create({ doc: code, plugins: stateFor("").plugins }), " ");
    assert.equal(hrefOf(coded, "https://example.com"), null);
    assert.equal(hasMark(coded, "https://example.com", "code"), true);

    const math = schema.node("doc", null, [schema.node("paragraph", { id: "p" }, [schema.text("https://example.com", [schema.mark("math")])])]);
    const equated = type(EditorState.create({ doc: math, plugins: stateFor("").plugins }), " ");
    assert.equal(hrefOf(equated, "https://example.com"), null);
    assert.equal(hasMark(equated, "https://example.com", "math"), true);

    const block = schema.node("doc", null, [schema.node("code_block", { id: "c" }, schema.text("https://example.com"))]);
    const blocked = type(EditorState.create({ doc: block, plugins: stateFor("").plugins }), " ");
    assert.equal(hrefOf(blocked, "https://example.com"), null);
  });

  it("keeps a comment on text that becomes a link", () => {
    const comment = schema.mark("comment", { id: "c1" });
    const doc = schema.node("doc", null, [schema.node("paragraph", { id: "p" }, [schema.text("https://example.com", [comment])])]);
    const linked = type(EditorState.create({ doc, plugins: stateFor("").plugins }), " ");
    assert.equal(hrefOf(linked, "https://example.com"), "https://example.com");
    assert.equal(hasMark(linked, "https://example.com", "comment"), true);
  });
});

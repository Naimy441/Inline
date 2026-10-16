import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { DOMParser as PMDOMParser, type Node as PMNode } from "prosemirror-model";
import { Slice } from "prosemirror-model";
import { splitBlock } from "prosemirror-commands";
import { EditorState, TextSelection } from "prosemirror-state";

import { schema } from "@/lib/doc/schema";
import { goToDocumentEdge } from "@/lib/editor/commands";
import { endWithTextblock, fixGoogleDocsHtml, pasteIntoEmptyTextblock, transformPastedHtml } from "@/lib/editor/paste";
import { GOOGLE_PASSAGE, googleClipboard, googleParagraph } from "../../tests/support/googleClipboard";

const { window } = new JSDOM("");

/** Parse clipboard HTML as the editor does: Google's fixed first, then the schema's rules. */
function pasted(html: string) {
  const previous = globalThis.DOMParser;
  globalThis.DOMParser = window.DOMParser;
  try {
    const result = transformPastedHtml(html);
    const container = window.document.createElement("div");
    container.innerHTML = result.html;
    return { slice: PMDOMParser.fromSchema(schema).parseSlice(container), paragraphs: result.paragraphs };
  } finally {
    globalThis.DOMParser = previous;
  }
}

function blocks(content: { forEach(fn: (node: PMNode) => void): void }) {
  const out: { text: string; lineHeight: string | null; before: number | null; after: number | null; fontSize: number | null; breaks: number }[] = [];
  content.forEach((node) => {
    let breaks = 0;
    node.descendants((child) => void (child.type.name === "hard_break" && (breaks += 1)));
    out.push({ text: node.textContent.slice(0, 12), lineHeight: node.attrs.lineHeight, before: node.attrs.spaceBefore, after: node.attrs.spaceAfter, fontSize: node.attrs.fontSize, breaks });
  });
  return out;
}

describe("pasting from Google Docs", () => {
  it("reads Google's line spacing, spacing and blank lines as Google shows them", () => {
    const { slice } = pasted(GOOGLE_PASSAGE);
    const result = blocks(slice.content);
    assert.deepEqual(
      result.map((block) => block.text),
      ["3 parts @ 6 ", "", "PROLOGUE", "Scene of Sto", "", "Certainly! H"],
      "each blank line is one empty paragraph",
    );
    for (const block of result) {
      // Google writes 1.15 spacing as line-height 1.38 (1.15 × 1.2).
      assert.equal(block.lineHeight, "1.15", block.text);
      assert.equal(block.before, 0, block.text);
      assert.equal(block.after, 0, block.text);
      assert.equal(block.breaks, 0, "no line break makes a blank line two lines tall");
    }
    assert.equal(result[1]!.fontSize, 11, "a blank line is a line of its neighbours' text");
  });

  it("converts each line spacing Google offers", () => {
    for (const [written, spacing] of [["1.2", "1"], ["1.38", "1.15"], ["1.7999999999999998", "1.5"], ["2.4", "2"]] as const) {
      const { slice } = pasted(googleClipboard(googleParagraph("a", { lineHeight: written }) + googleParagraph("b", { lineHeight: written })));
      assert.equal(slice.content.firstChild!.attrs.lineHeight, spacing, written);
    }
  });

  it("keeps a line break inside a paragraph, and the space around paragraphs Google gives", () => {
    const html = googleClipboard(`<p dir="ltr" style="line-height:1.38;margin-top:12pt;margin-bottom:6pt;"><span>one</span><br><span>two</span></p>`);
    const { slice } = pasted(html);
    assert.deepEqual(blocks(slice.content), [{ text: "onetwo", lineHeight: "1.15", before: 12, after: 6, fontSize: null, breaks: 1 }]);
  });

  it("leaves part of a paragraph, and other HTML, as they were", () => {
    const part = googleClipboard('<span style="font-size:11pt;">part of</span><br><span>a line</span>');
    const partial = pasted(part);
    assert.equal(partial.paragraphs, false);
    const kinds: string[] = [];
    partial.slice.content.descendants((node) => void kinds.push(node.type.name));
    assert.deepEqual(kinds, ["text", "hard_break", "text"], "a line break between bits of text stays one");
    const other = '<p style="line-height: 1.38">x</p><br><p>y</p>';
    const { window: page } = new JSDOM(other);
    assert.equal(fixGoogleDocsHtml(page.document.body), false);
    assert.equal(page.document.body.innerHTML, other);
  });

  it("replaces the empty paragraph it's pasted into, so the first paragraph keeps its spacing", () => {
    const { slice, paragraphs } = pasted(GOOGLE_PASSAGE);
    assert.ok(paragraphs);
    const doc = schema.node("doc", null, [schema.node("paragraph"), schema.node("paragraph", null, [schema.text("after")])]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1) });
    const result = state.tr.replaceSelection(pasteIntoEmptyTextblock(slice, state)).doc;
    assert.deepEqual(
      blocks(result.content).map((block) => [block.text, block.after]),
      [["3 parts @ 6 ", 0], ["", 0], ["PROLOGUE", 0], ["Scene of Sto", 0], ["", 0], ["Certainly! H", 0], ["after", null]],
    );
    // Into text, the first paragraph still joins the one the cursor is in.
    const text = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("ab")])]);
    const inText = EditorState.create({ doc: text, selection: TextSelection.create(text, 2) });
    assert.equal(pasteIntoEmptyTextblock(slice, inText), slice);
  });
});

describe("pasting a picture", () => {
  const image = () => schema.node("image", { src: "/api/uploads/a.png" });
  const paste = (doc: PMNode, at: number, slice: Slice) => {
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, at) });
    const tr = state.tr.replaceSelection(endWithTextblock(slice, state) ?? slice);
    const kinds: string[] = [];
    tr.doc.forEach((node) => void kinds.push(node.type.name));
    return { kinds, selection: tr.selection, doc: tr.doc };
  };

  it("leaves a text caret on a line after it, keeping the empty paragraph it went into", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("text")]), schema.node("paragraph", { align: "center" })]);
    const result = paste(doc, 7, new Slice(schema.node("doc", null, [image()]).content, 0, 0));
    assert.deepEqual(result.kinds, ["paragraph", "image", "paragraph"]);
    assert.ok(result.selection instanceof TextSelection && result.selection.empty);
    assert.equal(result.selection.$from.parent, result.doc.lastChild);
    assert.equal(result.doc.lastChild!.attrs.align, "center");
  });

  it("splits text it's pasted into, the cursor before the rest", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("abcd")])]);
    const result = paste(doc, 3, new Slice(schema.node("doc", null, [image()]).content, 0, 0));
    assert.deepEqual(result.kinds, ["paragraph", "image", "paragraph"]);
    assert.equal(result.doc.lastChild!.textContent, "cd");
    assert.equal(result.selection.$from.parentOffset, 0);
    assert.equal(result.selection.$from.parent, result.doc.lastChild);
  });

  it("reads a pasted picture the way the clipboard parser does, and leaves the caret after it", () => {
    const { window } = new JSDOM(`<img src="/api/uploads/a.png">`);
    const parsed = PMDOMParser.fromSchema(schema).parseSlice(window.document.body, { preserveWhitespace: false });
    const slice = Slice.maxOpen(parsed.content, true);
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("Before.")]), schema.node("paragraph")]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 10) });
    const ended = endWithTextblock(slice, state);
    const tr = state.tr.replaceSelection(ended ?? slice);
    const kinds: string[] = [];
    tr.doc.forEach((node) => kinds.push(`${node.type.name}:${node.textContent}`));
    assert.deepEqual(kinds, ["paragraph:Before.", "image:", "paragraph:"]);
    assert.equal(tr.selection.$from.parent, tr.doc.lastChild);
    assert.equal(tr.selection.$from.parentOffset, 0);
    assert.ok(tr.selection instanceof TextSelection);
  });

  it("pasted at the end of a paragraph leaves the caret on the following line", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", { id: "a" }, [schema.text("Before.")])]);
    const result = paste(doc, 8, new Slice(schema.node("doc", null, [image()]).content, 0, 0));
    assert.deepEqual(result.kinds, ["paragraph", "image", "paragraph"]);
    assert.equal(result.doc.firstChild!.textContent, "Before.");
    assert.equal(result.doc.lastChild!.textContent, "");
    assert.equal(result.selection.$from.parent, result.doc.lastChild);
    assert.equal(result.selection.$from.parentOffset, 0);
  });

  it("Ctrl+End then Enter still pastes the picture onto the following line when the caret started at the beginning", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("Before.")])]);
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 1) });
    goToDocumentEdge("end")(state, (tr) => (state = state.apply(tr)));
    splitBlock(state, (tr) => (state = state.apply(tr)));
    const ended = endWithTextblock(new Slice(schema.node("doc", null, [image()]).content, 0, 0), state);
    const tr = state.tr.replaceSelection(ended!);
    const kinds: string[] = [];
    tr.doc.forEach((node) => kinds.push(`${node.type.name}:${node.textContent}`));
    assert.deepEqual(kinds, ["paragraph:Before.", "image:", "paragraph:"]);
    assert.equal(tr.selection.$from.parent, tr.doc.lastChild);
    assert.equal(tr.selection.$from.parent.textContent, "");
  });

  it("leaves pastes that end in text alone", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph")]);
    const state = EditorState.create({ doc });
    assert.equal(endWithTextblock(new Slice(schema.node("doc", null, [schema.node("paragraph", null, [schema.text("x")])]).content, 1, 1), state), null);
  });
});

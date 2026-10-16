import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { DOMParser as PMDOMParser, type Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";

import { schema } from "@/lib/doc/schema";
import { fixGoogleDocsHtml, pasteIntoEmptyTextblock, transformPastedHtml } from "@/lib/editor/paste";
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

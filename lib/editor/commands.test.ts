import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { ensureBlockIds } from "../doc/ids";
import { docToMarkdown, markdownToDoc } from "../doc/markdown";
import { blockPosById, changeCase, goToDocumentEdge, insertTab, insertTableOfContents, removeTableOfContents } from "./commands";

function stateFor(markdown: string) {
  return EditorState.create({ doc: ensureBlockIds(markdownToDoc(markdown)) });
}

function selectAll(state: EditorState) {
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)));
}

function run(state: EditorState, command: Command) {
  let next = state;
  const ok = command(state, (tr) => (next = state.apply(tr)));
  return { ok, state: next };
}

describe("goToDocumentEdge", () => {
  it("puts the caret at the end of the last paragraph", () => {
    const { state } = run(stateFor("Before.\n\nAfter."), goToDocumentEdge("end"));
    assert.equal(state.selection.$from.parent.textContent, "After.");
    assert.equal(state.selection.$from.parentOffset, "After.".length);
  });
});

describe("changeCase", () => {
  const text = "the **quick** brown fox. it jumps";

  it("uppercases and keeps marks", () => {
    const { state } = run(selectAll(stateFor(text)), changeCase("upper"));
    assert.equal(docToMarkdown(state.doc).trim(), "THE **QUICK** BROWN FOX. IT JUMPS");
  });

  it("title-cases, leaving small words lowercase", () => {
    const { state } = run(selectAll(stateFor(text)), changeCase("title"));
    assert.equal(docToMarkdown(state.doc).trim(), "The **Quick** Brown Fox. It Jumps");
  });

  it("sentence-cases each sentence", () => {
    const { state } = run(selectAll(stateFor("THE FOX. IT JUMPS")), changeCase("sentence"));
    assert.equal(docToMarkdown(state.doc).trim(), "The fox. It jumps");
  });

  it("does nothing without a selection", () => {
    assert.equal(run(stateFor(text), changeCase("upper")).ok, false);
  });
});

describe("insertTableOfContents", () => {
  it("inserts one contents field whose entries link to the headings", () => {
    const start = stateFor("Intro text\n\n# One\n\nBody\n\n## Two\n\nMore\n\n### Three\n\n#### Four");
    const { ok, state } = run(start, insertTableOfContents);
    assert.ok(ok);
    const toc = state.doc.firstChild!;
    assert.equal(toc.type.name, "toc");
    const entries: Array<{ text: string; href: string | null }> = [];
    toc.forEach((node) => {
      if (node.type.name === "toc_entry") entries.push({ text: String(node.attrs.text), href: node.attrs.href as string | null });
    });
    assert.deepEqual(entries.map((entry) => entry.text), ["One", "Two", "Three"]);
    for (const entry of entries) {
      assert.ok(entry.href?.startsWith("#"));
      assert.notEqual(blockPosById(state.doc, entry.href!.slice(1)), null);
    }
    assert.equal(docToMarkdown(state.doc).split("\n\n")[0], "\\tableofcontents");
    assert.equal(state.selection.$from.parent.type.name, "toc_title");
    assert.equal(state.doc.firstChild!.firstChild!.textContent, "Contents");
    const again = run(state, insertTableOfContents);
    assert.equal(again.state.doc.childCount, state.doc.childCount);
    assert.ok(again.state.selection instanceof TextSelection);
    assert.equal(again.state.selection.$from.parent.type.name, "toc_title");
  });

  it("inserts a field with no headings, and removes the whole field", () => {
    const { ok, state } = run(stateFor("Just text"), insertTableOfContents);
    assert.equal(ok, true);
    assert.equal(state.doc.firstChild!.type.name, "toc");
    assert.equal(state.doc.firstChild!.child(1).attrs.placeholder, true);
    const removed = run(state, removeTableOfContents);
    assert.equal(removed.ok, true);
    assert.notEqual(removed.state.doc.firstChild!.type.name, "toc");
    assert.equal(run(removed.state, removeTableOfContents).ok, false);
  });
});

describe("insertTab", () => {
  const at = (state: EditorState, text: string) => {
    let found = -1;
    state.doc.descendants((node, pos) => {
      if (found < 0 && node.isText && node.text!.includes(text)) found = pos + node.text!.indexOf(text);
    });
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, found)));
  };

  it("types a tab in the middle of a line", () => {
    const { ok, state } = run(at(stateFor("Duke University Durham"), "Durham"), insertTab);
    assert.ok(ok);
    assert.equal(state.doc.textContent, "Duke University \tDurham");
  });

  it("types a tab at the start of a paragraph", () => {
    const { state } = run(at(stateFor("Indented"), "Indented"), insertTab);
    assert.equal(state.doc.textContent, "\tIndented");
  });

  it("leaves a list item's start to nesting", () => {
    assert.equal(run(at(stateFor("- one\n- two"), "two"), insertTab).ok, false);
  });

  it("types a tab at the start of a first list item, which can't nest", () => {
    const { ok, state } = run(at(stateFor("- one\n- two"), "one"), insertTab);
    assert.ok(ok);
    assert.equal(state.doc.textContent, "\tonetwo");
  });

  it("types a tab inside a list item's text", () => {
    const { state } = run(at(stateFor("- one\n- two words"), "words"), insertTab);
    assert.equal(state.doc.textContent, "onetwo \twords");
  });

  it("leaves a selection over several paragraphs to indenting", () => {
    assert.equal(run(selectAll(stateFor("First\n\nSecond")), insertTab).ok, false);
  });
});

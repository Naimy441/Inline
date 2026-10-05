import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { ensureBlockIds } from "../doc/ids";
import { docToMarkdown, markdownToDoc } from "../doc/markdown";
import { blockPosById, changeCase, insertTableOfContents } from "./commands";

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
  it("lists headings as links to their blocks", () => {
    const start = stateFor("Intro text\n\n# One\n\nBody\n\n## Two\n\nMore");
    const { ok, state } = run(start, insertTableOfContents);
    assert.ok(ok);
    const links: string[] = [];
    state.doc.descendants((node) => {
      const link = node.marks.find((mark) => mark.type.name === "link");
      if (link) links.push(`${node.text}->${String(link.attrs.href)}`);
    });
    assert.equal(links.length, 2);
    for (const entry of links) {
      const id = entry.split("->#")[1]!;
      assert.notEqual(blockPosById(state.doc, id), null);
    }
    assert.match(links[0]!, /^One->#/);
  });

  it("refuses when there are no headings", () => {
    assert.equal(run(stateFor("Just text"), insertTableOfContents).ok, false);
  });
});

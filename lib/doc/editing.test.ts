import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import {
  docPlainText,
  docWordCount,
  wordCount,
  applyBlockStyle,
  applyFormat,
  applyStringEdit,
  applyStringEdits,
  EditError,
  findText,
  insertMarkdown,
  LockedContentError,
  numberLines,
  searchLines,
  writeDocument,
} from "./editing";
import { ensureBlockIds } from "./ids";
import { docToMarkdown, markdownToDoc, serializeDoc } from "./markdown";
import { schema } from "./schema";

function doc(md: string) {
  return ensureBlockIds(markdownToDoc(md));
}

function edit(source: PMNode, old_string: string, new_string: string, replace_all = false) {
  const tr = new Transform(source);
  applyStringEdit(tr, { old_string, new_string, replace_all });
  return tr;
}

/** Collect [text, markNames] runs for compact assertions. */
function runs(node: PMNode) {
  const out: Array<[string, string]> = [];
  node.descendants((child) => {
    if (child.isText) out.push([child.text ?? "", child.marks.map((mark) => (mark.attrs.color ? `${mark.type.name}:${mark.attrs.color}` : mark.type.name)).join(",")]);
    return true;
  });
  return out;
}

describe("markdown round trip", () => {
  const cases = [
    "# Title {.title}\n\nSubtitle line {.subtitle}\n\n## Section {align=center}\n\nBody with **bold**, *italic*, ~~strike~~, `code`, ==mark==, <u>under</u>, x<sup>2</sup>, H<sub>2</sub>O and [a link](https://example.com).",
    "- one\n- two\n  - nested\n- [ ] todo\n- [x] done",
    "1. first\n2. second\n\n&nbsp;\n\n> quoted\n>\n> two",
    "```ts\nconst x = 1;\n```\n\n---\n\n\\pagebreak\n\n![Alt](https://e.com/a.png){width=40% align=left}",
    "| A | B |\n| --- | :---: |\n| 1 | 2 |\n| 3<br>4 | 5 |",
    "Literal \\*stars\\*, snake_case, 3 < 4, \\# not a heading, a\\_b\\_ and \\[x\\](y).",
    "Indented paragraph {indent=2}\n\nJustified text here. {align=justify}",
  ];
  for (const md of cases) {
    it(`is stable: ${md.slice(0, 40).replace(/\n/g, "⏎")}`, () => {
      const once = docToMarkdown(markdownToDoc(md));
      assert.equal(docToMarkdown(markdownToDoc(once)), once);
    });
  }

  it("keeps formatting through serialize/parse", () => {
    const source = markdownToDoc("A **bold *both*** and *it* end.");
    assert.deepEqual(runs(markdownToDoc(docToMarkdown(source))), runs(source));
  });

  it("parses titles, alignment and task items", () => {
    const parsed = markdownToDoc("# Big {.title align=center}\n\n- [x] shipped");
    assert.equal(parsed.child(0).type.name, "title");
    assert.equal(parsed.child(0).attrs.align, "center");
    assert.equal(parsed.child(1).child(0).attrs.checked, true);
    assert.equal(parsed.child(1).child(0).textContent, "shipped");
  });
});

describe("applyStringEdit", () => {
  it("edits within a paragraph and keeps unchanged styling", () => {
    let source = doc("The quick brown fox jumps.");
    // Color the word "brown" (not expressible in Markdown).
    const tr0 = new Transform(source);
    const [hit] = findText(source, "brown");
    applyFormat(tr0, hit!.from, hit!.to, { color: "#ff0000" });
    source = tr0.doc;
    const result = edit(source, "quick brown fox", "slow brown dog").doc;
    assert.equal(result.textContent, "The slow brown dog jumps.");
    assert.deepEqual(runs(result), [
      ["The slow ", ""],
      ["brown", "text_color:#ff0000"],
      [" dog jumps.", ""],
    ]);
  });

  it("new words inherit the style of the words they replace", () => {
    let source = doc("Keep this red phrase please.");
    const tr0 = new Transform(source);
    const [hit] = findText(source, "red phrase");
    applyFormat(tr0, hit!.from, hit!.to, { color: "red" });
    source = tr0.doc;
    const result = edit(source, "red phrase", "crimson wording").doc;
    assert.deepEqual(runs(result), [
      ["Keep this ", ""],
      ["crimson wording", "text_color:red"],
      [" please.", ""],
    ]);
  });

  it("produces a minimal step and keeps block ids", () => {
    const source = doc("First paragraph.\n\nSecond paragraph here.\n\nThird.");
    const ids = [0, 1, 2].map((i) => source.child(i).attrs.id);
    const tr = edit(source, "Second paragraph", "2nd paragraph");
    assert.equal(tr.steps.length, 1);
    assert.deepEqual([0, 1, 2].map((i) => tr.doc.child(i).attrs.id), ids);
    assert.equal(docToMarkdown(tr.doc), "First paragraph.\n\n2nd paragraph here.\n\nThird.");
  });

  it("can split, insert and delete blocks", () => {
    const source = doc("Alpha beta. Gamma delta.\n\nOmega.");
    const split = edit(source, "Alpha beta. Gamma delta.", "Alpha beta.\n\nGamma delta.").doc;
    assert.equal(split.childCount, 3);
    assert.equal(split.child(0).attrs.id, source.child(0).attrs.id);
    const removed = edit(source, "Alpha beta. Gamma delta.\n\n", "").doc;
    assert.equal(docToMarkdown(removed), "Omega.");
  });

  it("changes block types through Markdown", () => {
    const source = doc("Intro\n\nBody text.");
    const result = edit(source, "Intro", "## Intro").doc;
    assert.equal(result.child(0).type.name, "heading");
    assert.equal(result.child(0).attrs.level, 2);
    assert.equal(result.child(0).attrs.id, source.child(0).attrs.id);
  });

  it("edits list items in place", () => {
    const source = doc("- apples\n- pears\n- plums");
    const result = edit(source, "- pears", "- ripe pears\n- figs").doc;
    assert.equal(docToMarkdown(result), "- apples\n- ripe pears\n- figs\n- plums");
  });

  it("reports missing and ambiguous matches like Claude Code's Edit tool", () => {
    const source = doc("Repeat this. Repeat this.");
    assert.throws(() => edit(source, "nowhere", "x"), (error: Error) => error instanceof EditError && /not found/.test(error.message));
    assert.throws(() => edit(source, "Repeat this.", "x"), /Found 2 matches/);
    assert.equal(edit(source, "Repeat this.", "Once.", true).doc.textContent, "Once. Once.");
  });

  it("matches straight quotes against curly quotes and keeps the document's style", () => {
    const source = doc("She said “hello” to them.");
    const result = edit(source, 'said "hello"', 'said "goodbye"').doc;
    assert.equal(result.textContent, "She said “goodbye” to them.");
  });

  it("ignores line-number prefixes copied from read output", () => {
    const source = doc("One line.\n\nTwo line.");
    const result = edit(source, "     3\tTwo line.", "Second line.").doc;
    assert.equal(result.child(1).textContent, "Second line.");
  });

  it("refuses to change locked text but allows edits around it", () => {
    let source = doc("Do not touch this sentence. Free text here.");
    const tr0 = new Transform(source);
    const [hit] = findText(source, "Do not touch this sentence.");
    tr0.addMark(hit!.from, hit!.to, schema.mark("locked", { id: "l1" }));
    source = tr0.doc;
    assert.throws(() => edit(source, "touch this", "edit this"), LockedContentError);
    const ok = edit(source, "Free text", "Open text").doc;
    assert.equal(ok.textContent, "Do not touch this sentence. Open text here.");
    assert.ok(runs(ok)[0]![1].includes("locked"));
  });

  it("keeps comment anchors on unchanged text", () => {
    let source = doc("Commented words stay anchored.");
    const tr0 = new Transform(source);
    const [hit] = findText(source, "words stay");
    tr0.addMark(hit!.from, hit!.to, schema.mark("comment", { id: "c1" }));
    source = tr0.doc;
    const result = edit(source, "anchored", "put").doc;
    assert.deepEqual(runs(result), [
      ["Commented ", ""],
      ["words stay", "comment"],
      [" put.", ""],
    ]);
  });

  it("applies multi-edits atomically", () => {
    const source = doc("a b c");
    assert.throws(() => applyStringEdits(source, [{ old_string: "a", new_string: "x" }, { old_string: "zzz", new_string: "y" }]), /Edit 2 of 2/);
    assert.equal(applyStringEdits(source, [{ old_string: "a", new_string: "x" }, { old_string: "c", new_string: "z" }]).doc.textContent, "x b z");
  });
});

describe("whole-document operations", () => {
  it("write_document keeps identical blocks untouched", () => {
    const source = doc("# Heading\n\nPara one.\n\nPara two.");
    const tr = writeDocument(source, "# Heading\n\nPara one, revised.\n\nPara two.\n\nPara three.");
    assert.equal(tr.doc.child(0).attrs.id, source.child(0).attrs.id);
    assert.equal(tr.doc.child(2).attrs.id, source.child(2).attrs.id);
    assert.equal(tr.doc.childCount, 4);
  });

  it("inserts at the end, after a line, and into an empty document", () => {
    const empty = schema.node("doc", null, [schema.node("paragraph")]);
    assert.equal(docToMarkdown(insertMarkdown(empty, "Hello", { at: "end" }).doc), "Hello");
    const source = doc("One\n\nThree");
    assert.equal(docToMarkdown(insertMarkdown(source, "Two", { afterLine: 1 }).doc), "One\n\nTwo\n\nThree");
    assert.equal(docToMarkdown(insertMarkdown(source, "Zero", { at: "start" }).doc), "Zero\n\nOne\n\nThree");
  });

  it("numbers lines like cat -n", () => {
    const lines = serializeDoc(doc("A\n\nB")).markdown.split("\n");
    assert.equal(numberLines(lines), "     1\tA\n     2\t\n     3\tB");
  });

  it("searches lines", () => {
    const result = searchLines(doc("Alpha\n\nbeta ALPHA"), "alpha");
    assert.deepEqual(result.hits.map((hit) => hit.line), [1, 3]);
  });

  it("sets block styles by line range", () => {
    const tr = new Transform(doc("One\n\nTwo"));
    applyBlockStyle(tr, { from: 1, to: 3 }, { type: "heading", level: 2, align: "center" });
    assert.equal(docToMarkdown(tr.doc), "## One {align=center}\n\n## Two {align=center}");
  });
});

describe("docWordCount", () => {
  it("matches counting the whole plain text, and recounts only what changed", () => {
    const doc = markdownToDoc("# Title here\n\nOne two three.\n\n- first item\n- second item\n\n> quoted words\n\nline one  \nline two");
    assert.equal(docWordCount(doc), wordCount(docPlainText(doc)));
    const tr = new Transform(doc).insert(doc.child(0).nodeSize + doc.child(1).nodeSize - 2, schema.text(" four"));
    assert.equal(docWordCount(tr.doc), wordCount(docPlainText(tr.doc)));
    assert.equal(docWordCount(tr.doc), docWordCount(doc) + 1);
  });
});

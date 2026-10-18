import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileCanvas } from "@/lib/canvas/compiler";
import type { Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import {
  docPlainText,
  docWordCount,
  followedDocumentTitle,
  wordCount,
  applyBlockStyle,
  applyFormat,
  applyStringEdit,
  applyStringEdits,
  EditError,
  findText,
  insertMarkdown,
  LockedContentError,
  mathWarnings,
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

describe("followed document title", () => {
  it("uses the first line of text, whatever its style", () => {
    assert.equal(followedDocumentTitle(markdownToDoc("Meeting notes")), "Meeting notes");
    assert.equal(followedDocumentTitle(markdownToDoc("# Section")), "Section");
    assert.equal(followedDocumentTitle(markdownToDoc("# Big {.title}")), "Big");
  });

  it("ignores a title below the first line and a blank title above the text", () => {
    assert.equal(followedDocumentTitle(markdownToDoc("Notes\n\n# Big {.title}")), "Notes");
    const blankTitle = schema.node("doc", null, [schema.node("title"), schema.node("paragraph", null, [schema.text("Still here")])]);
    assert.equal(followedDocumentTitle(blankTitle), "Still here");
  });

  it("has no name when the document is empty", () => {
    assert.equal(followedDocumentTitle(schema.node("doc", null, [schema.node("paragraph")])), null);
  });

  it("names a Canvas from its h1, not the eyebrow above it", () => {
    const doc = compileCanvas('<Canvas><Text class="eyebrow">§ CALCULUS · PROBLEM SET 01</Text><Text as="h1">The fundamental theorem</Text><Text>Q.E.D.</Text></Canvas>');
    assert.equal(followedDocumentTitle(doc), "The fundamental theorem");
  });
});

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
      ["The ", ""],
      ["slow", "agent"],
      [" ", ""],
      ["brown", "text_color:#ff0000"],
      [" ", ""],
      ["dog", "agent"],
      [" jumps.", ""],
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
      ["crimson", "text_color:red,agent"],
      [" ", "text_color:red"],
      ["wording", "text_color:red,agent"],
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
      [" ", ""],
      ["put", "agent"],
      [".", ""],
    ]);
  });

  it("rewrites words beside an inline equation without splitting the equation", () => {
    const source = doc("Call $z = x + iy$ that point.");
    const result = edit(source, "Call $z = x + iy$ that point.", "Call z that $z = x + iy$ that point.").doc;
    assert.equal(docToMarkdown(result), "Call z that $z = x + iy$ that point.");
  });

  it("rewrites words around a formula that is also written as plain text", () => {
    const source = doc("This generalizes $x + y$ the sum x + y.");
    const result = edit(source, "This generalizes $x + y$ the sum x + y.", "This x + y generalizes $x + y$ the sum.").doc;
    assert.equal(docToMarkdown(result), "This x + y generalizes $x + y$ the sum.");
  });

  it("still replaces an equation when the equation itself changes", () => {
    const source = doc("Energy is $E = mc^2$ today.");
    const result = edit(source, "$E = mc^2$", "$E = mc^2 + 1$").doc;
    assert.equal(docToMarkdown(result), "Energy is $E = mc^2 + 1$ today.");
  });

  it("replaces an inline picture instead of keeping the previous one", () => {
    const source = doc("See ![old](/a.png) here.");
    const result = edit(source, "![old](/a.png)", "![new](/b.png)").doc;
    assert.equal(docToMarkdown(result), "See ![new](/b.png) here.");
  });

  it("keeps a link whole when the words beside it change", () => {
    const source = doc("Read [the notes](https://example.com/a) today.");
    const result = edit(source, "today", "tomorrow").doc;
    assert.equal(docToMarkdown(result), "Read [the notes](https://example.com/a) tomorrow.");
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

  it("accepts a displayed equation from write_document and insert_content", () => {
    const empty = schema.node("doc", null, [schema.node("paragraph")]);
    for (const markdown of ["$$y = x^2 - 2x - 3$$", "$$\ny = x^2 - 2x - 3\n$$"]) {
      const written = writeDocument(empty, markdown);
      const fixes = ensureBlockIds(written.doc);
      fixes.check();
      assert.equal(fixes.child(0).type.name, "code_block");
      assert.equal(fixes.child(0).attrs.language, "math");
      assert.equal(fixes.child(0).textContent, "y = x^2 - 2x - 3");
      assert.equal(fixes.child(0).firstChild?.marks.length ?? 0, 0);
      const inserted = insertMarkdown(empty, markdown, { at: "end" });
      ensureBlockIds(inserted.doc).check();
      assert.equal(inserted.doc.child(0).attrs.language, "math");
    }
    const prose = insertMarkdown(empty, "See $y = x^2$.", { at: "end" });
    const equation = runs(prose.doc).find(([text]) => text === "y = x^2");
    assert.ok(equation);
    assert.ok(equation[1].split(",").includes("math"));
    assert.ok(equation[1].split(",").includes("agent"));
  });

  it("inserts at the end, after a line, and into an empty document", () => {
    const empty = schema.node("doc", null, [schema.node("paragraph")]);
    assert.equal(docToMarkdown(insertMarkdown(empty, "Hello", { at: "end" }).doc), "Hello");
    const source = doc("One\n\nThree");
    const inserted = insertMarkdown(source, "Two", { afterLine: 1 }).doc;
    assert.equal(docToMarkdown(inserted), "One\n\nTwo\n\nThree");
    assert.equal(runs(inserted)[1]?.[1], "agent");
    assert.equal(runs(inserted)[0]?.[1], "");
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

describe("math markdown round trip", () => {
  for (const markdown of ["Call $z = x + iy$ that point.", "This generalizes $x + y$ the sum."]) {
    it(`reads back as the same document: ${markdown}`, () => {
      const once = docToMarkdown(markdownToDoc(markdown));
      assert.equal(once, markdown);
      assert.equal(docToMarkdown(markdownToDoc(once)), once);
    });
  }

  it("does not leave a whitespace-only equation behind", () => {
    const math = schema.mark("math");
    const paragraph = schema.node("paragraph", null, [schema.text("A"), schema.text(" ", [math]), schema.text("B")]);
    const source = schema.node("doc", null, [paragraph]);
    const markdown = docToMarkdown(source);
    assert.equal(markdown, "A B");
    assert.equal(mathWarnings(markdown).length, 0);
    const again = markdownToDoc(markdown);
    again.descendants((node) => {
      assert.equal(node.marks.some((mark) => mark.type.name === "math"), false);
    });
    assert.equal(docToMarkdown(again), markdown);
  });

  it("warns when a dollar sign is stuck to a word or the equation is empty", () => {
    const warnings = mathWarnings("This generalizes$ $the sum.");
    assert.ok(warnings.some((warning) => /empty inline math/.test(warning)));
    assert.ok(warnings.some((warning) => /stuck to a word/.test(warning)));
    assert.equal(mathWarnings("Call $z = x + iy$ that point.").length, 0);
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

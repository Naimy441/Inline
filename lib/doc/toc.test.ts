import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensureBlockIds } from "./ids";
import { docToMarkdown, markdownToDoc } from "./markdown";
import { describeToc, pageFromStarts, tocMarkdownMatch, withSyncedTocs } from "./toc";

const sample = "Intro\n\n# One\n\nBody\n\n## Two\n\nMore\n\n### Skipped later\n\n#### Too deep";

describe("table of contents", () => {
  it("round-trips as one field and lists headings through the chosen depth", () => {
    const doc = ensureBlockIds(markdownToDoc(`${sample}\n\n\\tableofcontents {depth=2}`));
    assert.equal(tocMarkdownMatch("\\tableofcontents")?.depth, 3);
    assert.equal(tocMarkdownMatch("\\tableofcontents {depth=2}")?.depth, 2);
    assert.match(docToMarkdown(doc), /\\tableofcontents \{depth=2\}/);
    const toc = [...doc.children].find((node) => node.type.name === "toc")!;
    const texts: string[] = [];
    toc.forEach((child) => {
      if (child.type.name === "toc_entry") texts.push(String(child.attrs.text));
    });
    assert.deepEqual(texts, ["One", "Two"]);
    const href = String(toc.child(1).attrs.href);
    assert.ok(href.startsWith("#"));
    assert.equal(docToMarkdown(markdownToDoc(docToMarkdown(doc))).includes("\\tableofcontents {depth=2}"), true);
  });

  it("rebuilds entries when a heading changes and drops the field's placeholder", () => {
    const start = ensureBlockIds(markdownToDoc("Just text\n\n\\tableofcontents"));
    const toc = start.firstChild!.type.name === "toc" ? start.firstChild! : [...start.children].find((node) => node.type.name === "toc")!;
    assert.equal(toc.lastChild!.attrs.placeholder, true);
    const next = withSyncedTocs(markdownToDoc("# Added\n\n\\tableofcontents"));
    const rebuilt = [...ensureBlockIds(next).children].find((node) => node.type.name === "toc")!;
    assert.equal(rebuilt.lastChild!.attrs.text, "Added");
    assert.equal(rebuilt.lastChild!.attrs.placeholder, false);
  });

  it("numbers pages from where each later page starts", () => {
    assert.equal(pageFromStarts([], 10), 1);
    assert.equal(pageFromStarts([40, 80], 40), 2);
    assert.equal(pageFromStarts([40, 80], 81), 3);
    const doc = ensureBlockIds(markdownToDoc("# One\n\n# Two\n\n\\tableofcontents"));
    const text = describeToc(doc, [doc.child(1).nodeSize]);
    assert.match(text, /One\t1/);
    assert.match(text, /Two\t2/);
  });
});

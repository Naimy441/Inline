import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GapCursor } from "prosemirror-gapcursor";
import { ensureBlockIds } from "./ids";
import { docToMarkdown, markdownToDoc } from "./markdown";
import { mergeBlock } from "./merge";
import { schema } from "./schema";
import { describeToc, findToc, pageFromStarts, selectionReplacingTocGap, tocMarkdownMatch, withSyncedTocs } from "./toc";

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

  it("keeps a renamed heading through sync, markdown, and a merge", () => {
    assert.equal(tocMarkdownMatch('\\tableofcontents {title="Index"}')?.title, "Index");
    assert.equal(tocMarkdownMatch('\\tableofcontents {depth=2 title="Table of contents"}')?.depth, 2);
    assert.equal(tocMarkdownMatch('\\tableofcontents {depth=2 title="Table of contents"}')?.title, "Table of contents");
    assert.equal(tocMarkdownMatch(String.raw`\tableofcontents {title="Say \"Hi\""}`)?.title, 'Say "Hi"');
    assert.equal(tocMarkdownMatch("\\tableofcontents {color=red}"), null);
    const named = ensureBlockIds(markdownToDoc('# One\n\n\\tableofcontents {depth=2 title="Index"}'));
    const toc = [...named.children].find((node) => node.type.name === "toc")!;
    assert.equal(toc.firstChild!.textContent, "Index");
    assert.match(docToMarkdown(named), /\\tableofcontents \{depth=2 title="Index"\}/);
    const grown = ensureBlockIds(markdownToDoc('# One\n\n# Two\n\n\\tableofcontents {depth=2 title="Index"}'));
    const next = [...grown.children].find((node) => node.type.name === "toc")!;
    assert.equal(next.firstChild!.textContent, "Index");
    const entries: string[] = [];
    next.forEach((child) => {
      if (child.type.name === "toc_entry") entries.push(String(child.attrs.text));
    });
    assert.deepEqual(entries, ["One", "Two"]);
    const bare = markdownToDoc("\\tableofcontents").firstChild!;
    const renamed = markdownToDoc('\\tableofcontents {title="Overview"}').firstChild!;
    assert.equal(mergeBlock(toc, bare).firstChild!.textContent, "Index");
    assert.equal(mergeBlock(toc, renamed).firstChild!.textContent, "Overview");
    const legacy = schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "toc", attrs: { depth: 3 }, content: [{ type: "toc_title", attrs: { text: "Contents" } }] }],
    });
    const migrated = [...withSyncedTocs(legacy).children].find((node) => node.type.name === "toc")!;
    assert.equal(migrated.firstChild!.textContent, "Contents");
    assert.equal(migrated.firstChild!.attrs.text, null);
    assert.equal(docToMarkdown(withSyncedTocs(legacy)).includes("title="), false);
  });

  it("turns a gap cursor beside the field into a caret in the heading", () => {
    const doc = ensureBlockIds(markdownToDoc("\\tableofcontents\n\nAfter."));
    const before = selectionReplacingTocGap(doc, new GapCursor(doc.resolve(0)));
    assert.equal(before?.$from.parent.type.name, "toc_title");
    assert.equal(before?.$from.parentOffset, 0);
    const toc = findToc(doc)!;
    const after = selectionReplacingTocGap(doc, new GapCursor(doc.resolve(toc.pos + toc.node.nodeSize)));
    assert.equal(after?.$from.parent.type.name, "toc_title");
    assert.equal(after?.$from.parentOffset, after?.$from.parent.content.size);
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

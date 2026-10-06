import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Node as PMNode } from "prosemirror-model";
import { ensureBlockIds } from "./ids";
import { docToMarkdown, EMPTY_PARAGRAPH, markdownToDoc, PAGE_BREAK, parseMarkdown, serializeDoc } from "./markdown";

/** Markdown → document → Markdown must be stable for everything the dialect can express. */
function roundTrip(markdown: string) {
  return docToMarkdown(markdownToDoc(markdown));
}

function types(doc: PMNode) {
  const out: string[] = [];
  doc.forEach((child) => out.push(child.type.name));
  return out;
}

function marksOf(doc: PMNode, text: string) {
  let found: string[] | null = null;
  doc.descendants((node) => {
    if (found === null && node.isText && node.text === text) found = node.marks.map((mark) => mark.type.name).sort();
    return found === null;
  });
  return found;
}

describe("Markdown dialect round trip", () => {
  const stable = [
    ["headings", "# One\n\n## Two\n\n### Three\n\n#### Four"],
    ["bold, italic, strike and code", "Some **bold**, *italic*, ~~gone~~ and `code` text."],
    ["links", "Read [the docs](https://example.com/docs) first."],
    ["highlight, underline, superscript and subscript", "A ==marked== word, <u>under</u>, x<sup>2</sup> and H<sub>2</sub>O."],
    ["bulleted lists", "- one\n- two\n- three"],
    ["numbered lists", "1. first\n2. second\n3. third"],
    ["task lists", "- [ ] open\n- [x] done"],
    ["quotes", "> Quoted words."],
    ["code blocks", "```\nconst x = 1;\n```"],
    ["horizontal rules", "Above\n\n---\n\nBelow"],
    ["page breaks", `Before\n\n${PAGE_BREAK}\n\nAfter`],
    ["title and subtitle", "# Report {.title}\n\nA short summary {.subtitle}"],
    ["paragraph alignment and indent", "Centered {align=center}\n\nIndented {indent=2}"],
    ["line breaks inside a paragraph", "Line one<br>Line two"],
    ["empty paragraphs", `First\n\n${EMPTY_PARAGRAPH}\n\nSecond`],
    ["tables", "| Name | Score |\n| --- | --- |\n| Ada | 10 |"],
  ] as const;

  for (const [name, markdown] of stable) {
    it(`keeps ${name}`, () => {
      const once = roundTrip(markdown);
      assert.equal(roundTrip(once), once, "serialization is idempotent");
      for (const word of markdown.match(/[A-Za-z]{3,}/g) ?? []) {
        if (["align", "center", "indent", "title", "subtitle", "nbsp", "pagebreak", "https", "example", "com", "docs", "sup", "sub"].includes(word)) continue;
        assert.ok(once.includes(word), `"${word}" survives`);
      }
    });
  }
});

describe("parseMarkdown", () => {
  it("builds the right block types", () => {
    const doc = markdownToDoc("# Head\n\nText\n\n- item\n\n1. step\n\n> quote\n\n```\ncode\n```\n\n---");
    assert.deepEqual(types(doc), ["heading", "paragraph", "bullet_list", "ordered_list", "blockquote", "code_block", "horizontal_rule"]);
  });

  it("applies inline marks", () => {
    const doc = markdownToDoc("**bold** *italic* ~~strike~~ `code` ==mark==");
    assert.deepEqual(marksOf(doc, "bold"), ["bold"]);
    assert.deepEqual(marksOf(doc, "italic"), ["italic"]);
    assert.deepEqual(marksOf(doc, "strike"), ["strike"]);
    assert.deepEqual(marksOf(doc, "code"), ["code"]);
    assert.deepEqual(marksOf(doc, "mark"), ["highlight"]);
  });

  it("keeps the ordered list start number", () => {
    const [list] = parseMarkdown("4. four\n5. five");
    assert.equal(list!.type.name, "ordered_list");
    assert.equal(list!.attrs.order, 4);
  });

  it("reads image attributes", () => {
    const [para] = parseMarkdown("![A cat](https://example.com/cat.png){width=320 align=center}");
    let image: PMNode | null = null;
    para!.descendants((node) => {
      if (node.type.name === "image") image = node;
      return true;
    });
    const found = image ?? (para!.type.name === "image" ? para! : null);
    assert.ok(found, "image parsed");
    assert.equal((found as PMNode).attrs.alt, "A cat");
    assert.equal(Number((found as PMNode).attrs.width), 320);
  });

  it("treats a single newline as a soft wrap, as Markdown does", () => {
    const doc = markdownToDoc("one\ntwo");
    assert.equal(doc.childCount, 1);
    assert.match(doc.firstChild!.textContent, /one\s?two/);
  });

  it("returns an empty list for blank input", () => {
    assert.equal(parseMarkdown("   \n\n").length, 0);
  });
});

describe("serializeDoc", () => {
  it("maps every top-level block to its character span and position", () => {
    const doc = ensureBlockIds(markdownToDoc("# A\n\nB\n\n- c\n- d"));
    const serialized = serializeDoc(doc);
    assert.equal(serialized.blocks.length, 3);
    for (const block of serialized.blocks) {
      assert.equal(serialized.markdown.slice(block.start, block.end), block.markdown);
      assert.equal(doc.nodeAt(block.pos), block.node);
    }
    assert.equal(serialized.blocks[2]!.markdown, "- c\n- d");
  });

  it("escapes characters that would otherwise read as Markdown", () => {
    const doc = markdownToDoc("Price is 5 \\* 3 and \\# not a heading");
    const out = docToMarkdown(doc);
    assert.equal(markdownToDoc(out).textContent, doc.textContent);
  });
});

describe("templates", () => {
  it("every template parses and round-trips", async () => {
    const { documentTemplates } = await import("./templates");
    for (const template of documentTemplates(new Date(2026, 8, 4))) {
      if (!template.markdown) continue;
      assert.equal(roundTrip(template.markdown), docToMarkdown(markdownToDoc(roundTrip(template.markdown))), template.id);
    }
  });

  it("the MLA paper indents paragraphs, hangs Works Cited and breaks before it", async () => {
    const { documentTemplates } = await import("./templates");
    const mla = documentTemplates(new Date(2026, 8, 4)).find((template) => template.id === "mla")!;
    const doc = markdownToDoc(mla.markdown);
    assert.ok(types(doc).includes("page_break"));
    const indents: Record<string, number> = {};
    doc.forEach((node) => (indents[node.textContent.slice(0, 12)] = node.attrs.textIndent as number));
    assert.equal(indents["Begin your i"], 0.5);
    assert.equal(indents["Lastname, Fi"], -0.5);
    assert.ok(mla.markdown.includes("4 September 2026"));
    assert.ok(mla.markdown.includes("4 Sept. 2026"));
    assert.equal(mla.settings?.headerFooter?.header, "Lastname {page}");
  });
});

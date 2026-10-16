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
    ["inline citations", "See <cite>(Smith, 2020)</cite> and <cite>(Smith, *Title*, 2020)</cite> today."],
    ["footnotes", "A claim about sources.[^1] Another.[^smith]\n\n[^1]: The note with *italics*.\n\n[^smith]: A named note."],
    ["bibliography entries", "Smith, Ada. *Title*. Publisher, 2020. {.bibliography}\n\nWider entry. {.bibliography hanging=0.75}"],
  ] as const;

  for (const [name, markdown] of stable) {
    it(`keeps ${name}`, () => {
      const once = roundTrip(markdown);
      assert.equal(roundTrip(once), once, "serialization is idempotent");
      for (const word of markdown.match(/[A-Za-z]{3,}/g) ?? []) {
        if (["align", "center", "indent", "title", "subtitle", "nbsp", "pagebreak", "https", "example", "com", "docs", "sup", "sub", "cite"].includes(word)) continue;
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

  it("keeps wrap, crop and rotation on a picture, and a picture in the line", () => {
    const markdown = "![A cat](https://example.com/cat.png){width=220px align=left wrap=square crop=25,10,0,0 rotate=90}";
    const image = markdownToDoc(markdown).child(0);
    assert.equal(image.attrs.alt, "A cat");
    assert.equal(image.attrs.width, "220px");
    assert.equal(image.attrs.wrap, "square");
    assert.deepEqual(image.attrs.crop, { l: 0.25, t: 0.1, r: 0, b: 0 });
    assert.equal(image.attrs.rotate, 90);
    const again = markdownToDoc(docToMarkdown(markdownToDoc(markdown))).child(0);
    assert.equal(again.attrs.wrap, "square");
    assert.deepEqual(again.attrs.crop, image.attrs.crop);
    assert.equal(again.attrs.rotate, 90);
    assert.match(docToMarkdown(markdownToDoc(markdown)), /width=220px/);

    const lineDoc = markdownToDoc('Mark <img src="/api/uploads/a.png" width="80" height="40" alt="icon" data-crop="50,0,0,0" data-rotate="15"> here');
    const line = lineDoc.child(0);
    const inline = [...Array(line.childCount)].map((_, index) => line.child(index)).find((child) => child.type.name === "inline_image");
    assert.ok(inline);
    assert.equal(inline.attrs.alt, "icon");
    assert.equal(inline.attrs.width, 80);
    assert.deepEqual(inline.attrs.crop, { l: 0.5, t: 0, r: 0, b: 0 });
    assert.equal(inline.attrs.rotate, 15);
    const written = docToMarkdown(lineDoc);
    assert.match(written, /data-crop="50,0,0,0"/);
    assert.match(written, /data-rotate="15"/);
    const reread = markdownToDoc(written).child(0).child(1);
    assert.equal(reread.type.name, "inline_image");
    assert.deepEqual(reread.attrs.crop, inline.attrs.crop);
    assert.equal(reread.attrs.rotate, 15);
  });

  it("treats a single newline as a soft wrap, as Markdown does", () => {
    const doc = markdownToDoc("one\ntwo");
    assert.equal(doc.childCount, 1);
    assert.match(doc.firstChild!.textContent, /one\s?two/);
  });

  it("returns an empty list for blank input", () => {
    assert.equal(parseMarkdown("   \n\n").length, 0);
  });

  it("stores citations, footnote markers, footnote text and bibliography entries", () => {
    const doc = markdownToDoc("See <cite>(Smith, 2020)</cite>.[^1]\n\n[^1]: The note.\n\nSmith, Ada. *Title*. 2020. {.bibliography}");
    assert.deepEqual(marksOf(doc, "(Smith, 2020)"), ["citation"]);
    let marker = false;
    let note = false;
    let entry = false;
    doc.descendants((node) => {
      if (node.type.name === "footnote_ref" && node.attrs.label === "1") marker = true;
      if (node.attrs.footnote === "1" && node.textContent === "The note.") note = true;
      if (node.attrs.bibliography && node.attrs.textIndent === -0.5) entry = true;
    });
    assert.equal(marker && note && entry, true);
    assert.match(docToMarkdown(doc), /\[\^1\]: The note\./);
    assert.match(docToMarkdown(doc), /\{\.bibliography\}/);
    assert.doesNotMatch(docToMarkdown(doc), /hanging=0\.5/);
  });

  it("keeps a literal [^1] as text", () => {
    const markdown = "See \\[^1] here.";
    assert.equal(markdownToDoc(markdown).textContent, "See [^1] here.");
    assert.equal(roundTrip(markdown), markdown);
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

describe("equations", () => {
  const roundTrip = (markdown: string) => docToMarkdown(markdownToDoc(markdown));

  it("reads $…$ as an inline equation and writes it back", () => {
    const doc = markdownToDoc("Energy is $E = mc^2$, roughly.");
    const math = doc.firstChild!.child(1);
    assert.equal(math.text, "E = mc^2");
    assert.ok(math.marks.some((mark) => mark.type.name === "math"));
    assert.equal(roundTrip("Energy is $E = mc^2$, roughly."), "Energy is $E = mc^2$, roughly.");
  });

  it("reads a $$ block as a displayed equation", () => {
    const doc = markdownToDoc("$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$");
    assert.equal(doc.firstChild!.type.name, "code_block");
    assert.equal(doc.firstChild!.attrs.language, "math");
    assert.equal(doc.firstChild!.textContent, "\\int_0^1 x\\,dx = \\frac{1}{2}");
    assert.equal(roundTrip("$$x^2$$"), "$$\nx^2\n$$");
  });

  it("leaves prices alone and escapes dollar signs that could pair up", () => {
    const doc = markdownToDoc("It costs $5 and $10.");
    assert.equal(doc.textContent, "It costs $5 and $10.");
    assert.equal(docToMarkdown(doc), "It costs \\$5 and \\$10.");
    assert.equal(roundTrip(docToMarkdown(doc)), "It costs \\$5 and \\$10.");
    assert.equal(roundTrip("Only $5 here."), "Only $5 here.");
  });

  it("drops other formatting from an equation and keeps backslashes", () => {
    assert.equal(roundTrip("**bold $\\alpha$**"), "**bold** $\\alpha$");
    assert.equal(roundTrip("a $\\$5$ b"), "a $\\$5$ b");
  });
});

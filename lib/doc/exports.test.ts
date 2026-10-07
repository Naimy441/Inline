import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffSequences, textSimilarity } from "./diff";
import { documentToDocx, imageSize } from "./docx";
import { documentHtmlFile, escapeHtml, fragmentToHtml } from "./html";
import { latexToOmml } from "./omml";
import { blockIdFixes, ensureBlockIds, newId } from "./ids";
import { markdownToDoc } from "./markdown";
import { DEFAULT_SETTINGS, type DocumentMeta } from "./settings";
import { createZip } from "./zip";

const SAMPLE = "# Plan {.title}\n\nIntro with **bold** and a [link](https://example.com).\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |";

function meta(overrides: Partial<DocumentMeta> = {}): DocumentMeta {
  return { id: "d1", title: "Plan & <draft>", createdAt: 0, updatedAt: 0, lastOpenedAt: 0, trashedAt: null, settings: DEFAULT_SETTINGS, wordCount: 0, preview: "", ...overrides };
}

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("HTML export", () => {
  it("escapes text", () => {
    assert.equal(escapeHtml(`<a href="x">&</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });

  it("renders blocks, marks, links and tables", () => {
    const html = fragmentToHtml(markdownToDoc(SAMPLE));
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<a href="https:\/\/example.com"/);
    assert.match(html, /<ul>[\s\S]*<li>[\s\S]*one/);
    assert.match(html, /<table>[\s\S]*<td>[\s\S]*1/);
  });

  it("writes a standalone file with the page setup and an escaped title", () => {
    const html = documentHtmlFile(markdownToDoc(SAMPLE), meta());
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<title>Plan &amp; &lt;draft&gt;<\/title>/);
    assert.match(html, /@page \{ size: 8.5in 11in; margin: 1in 1in 1in 1in; \}/);
  });
});

describe("Word export", () => {
  it("builds a .docx package with the document text", async () => {
    const bytes = await documentToDocx(markdownToDoc(SAMPLE), meta(), async () => null);
    const text = latin1(bytes);
    assert.equal(text.slice(0, 2), "PK", "a ZIP file");
    for (const part of ["[Content_Types].xml", "word/document.xml", "word/styles.xml", "word/numbering.xml"]) assert.ok(text.includes(part), part);
    assert.ok(text.includes("Intro with "));
    assert.ok(text.includes("<w:b/>") || text.includes("<w:b "), "bold run");
    assert.ok(text.includes("<w:tbl>"), "table");
    assert.ok(text.includes("https://example.com"), "hyperlink target");
  });

  it("uses the document's paper size and margins", async () => {
    const settings = { ...DEFAULT_SETTINGS, pageSetup: { ...DEFAULT_SETTINGS.pageSetup, paperSize: "a4" as const, margins: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 } } };
    const text = latin1(await documentToDocx(markdownToDoc("Hi"), meta({ settings }), async () => null));
    assert.match(text, /<w:pgSz w:w="11906" w:h="16838"/);
    assert.match(text, /w:top="720"/);
  });

  it("embeds images it can load and skips ones it can't", async () => {
    const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
    const doc = markdownToDoc("![one](https://example.com/a.png)\n\n![two](https://example.com/missing.png)");
    const text = latin1(await documentToDocx(doc, meta(), async (src) => (src.endsWith("a.png") ? { data: png, mime: "image/png" } : null)));
    assert.ok(text.includes("word/media/"), "media part");
    assert.equal(text.split("<w:drawing>").length - 1, 1, "only the loadable image is drawn");
  });

  it("reads image dimensions from PNG headers", () => {
    const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEUlEQVR42mNk+M9QzwAEjDAGAKw3BP5PFSRuAAAAAElFTkSuQmCC", "base64"));
    assert.deepEqual(imageSize(png), { width: 2, height: 3 });
    assert.equal(imageSize(new Uint8Array([1, 2, 3])), null);
  });
});

describe("ZIP writer", () => {
  it("writes stored entries with an end-of-central-directory record", () => {
    const zip = latin1(createZip([{ name: "a.txt", data: "hello" }, { name: "b/c.txt", data: new Uint8Array([104, 105]) }]));
    assert.ok(zip.includes("a.txt") && zip.includes("hello") && zip.includes("b/c.txt"));
    assert.ok(zip.includes("PK\u0005\u0006"), "end of central directory");
    assert.equal(zip.split("PK\u0001\u0002").length - 1, 2, "two central directory entries");
  });
});

describe("block ids", () => {
  it("makes short random ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId()));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.match(id, /^[a-z0-9]{8}$/);
  });

  it("gives every block an id and fixes duplicates", () => {
    const doc = ensureBlockIds(markdownToDoc("A\n\nB\n\nC"));
    const ids: string[] = [];
    doc.forEach((child) => ids.push(child.attrs.id as string));
    assert.equal(new Set(ids).size, 3);
    assert.equal(blockIdFixes(doc), null, "nothing left to fix");

    const json = doc.toJSON() as { content: Array<{ attrs: { id: string } }> };
    json.content[1]!.attrs.id = json.content[0]!.attrs.id;
    const duplicated = doc.type.schema.nodeFromJSON(json);
    const fixes = blockIdFixes(duplicated);
    assert.ok(fixes, "the duplicate is fixed");
    const fixed: string[] = [];
    fixes!.doc.forEach((child) => fixed.push(child.attrs.id as string));
    assert.equal(new Set(fixed).size, 3);
  });
});

describe("diff", () => {
  it("finds equal, deleted and inserted runs", () => {
    const ops = diffSequences([..."abcdef"], [..."abXdeYf"]);
    const kinds = ops.map((op) => op.type);
    assert.ok(kinds.includes("equal") && kinds.includes("insert"));
    const rebuilt = ops.flatMap((op) => (op.type === "delete" ? [] : [..."abXdeYf"].slice(op.bStart, op.bEnd))).join("");
    assert.equal(rebuilt, "abXdeYf");
  });

  it("scores text similarity between 0 and 1", () => {
    assert.equal(textSimilarity("same text", "same text"), 1);
    assert.ok(textSimilarity("the quick brown fox", "the quick red fox") > 0.5);
    assert.ok(textSimilarity("alpha", "zzzzz") < 0.3);
  });
});

describe("equations in exports", () => {
  const doc = markdownToDoc("Inline $x^2$ here.\n\n$$\n\\frac{a}{b}\n$$");

  it("are MathML in HTML", () => {
    const html = fragmentToHtml(doc);
    assert.match(html, /<math[^>]*><semantics><mrow><msup><mi>x<\/mi><mn>2<\/mn><\/msup>/);
    assert.match(html, /<div class="math-display"><span class="katex"><math[^>]*display="block"/);
  });

  it("are Word equations in .docx", () => {
    const omml = latexToOmml("\\frac{a}{b} + \\sqrt{x}", false);
    assert.match(omml, /^<m:oMath><m:f><m:num>.*<m:t xml:space="preserve">a<\/m:t>.*<\/m:num><m:den>.*b.*<\/m:den><\/m:f>/);
    assert.match(omml, /<m:rad><m:radPr><m:degHide m:val="1"\/><\/m:radPr><m:deg\/><m:e>/);
    assert.match(latexToOmml("x", true), /^<m:oMathPara><m:oMath>/);
    assert.match(latexToOmml("\\frac{", false), /\\frac\{/);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { parseMarkdown } from "@/lib/doc/markdown";
import { analyzePage, settleInk, summarize, type AnalyzedPage } from "./analyze";
import { draftPage, type DraftContext } from "./draft";
import { buildTestPdf, featureTestPdf } from "./testPdf";

/**
 * One made-up PDF with everything the import has met in real course notes
 * (lib/pdf/import/testPdf.ts featureTestPdf), and the draft it must give:
 * what the PDF says, set as Inline's layout Markdown, exactly.
 */

async function analyzeFeatures() {
  const pdf = await getDocument({ data: featureTestPdf(), verbosity: 0, fontExtraProperties: true, useSystemFonts: false }).promise;
  const pages: AnalyzedPage[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) pages.push(await analyzePage(pdf, await pdf.getPage(number), OPS as never));
  settleInk(pages);
  return { pages, summary: summarize(pages.map((page) => page.analysis)) };
}

function draft(page: AnalyzedPage, summary: ReturnType<typeof summarize>) {
  const { margins } = summary.margins ? summary : { margins: { left: 1, right: 1, top: 1 } };
  const context: DraftContext = {
    page: page.analysis,
    summary,
    area: { left: margins.left * 72, top: margins.top * 72, width: 612 - (margins.left + margins.right) * 72 },
    fontSize: 12,
    lineSpacing: summary.lineSpacing,
    family: "CMR12 (notes)",
    fonts: {
      CMR12: { family: "CMR12 (notes)", bold: false, italic: false },
      CMBX12: { family: "CMR12 (notes)", bold: true, italic: false },
      CMR10: { family: "CMR10 (notes)", bold: false, italic: false },
    },
    crops: [],
  };
  return draftPage(context);
}

const PAGE_ONE = "## **1&emsp;Sample Section** {size=14.4 color=#000000 before=0 after=0}\n\nQuestions&#9;<span style=\"font-family: 'CMR10 (notes)'; font-size: 10pt\">1</span> {tabs=\"468:right\" before=10 after=0}\n\nThe first line of a justified paragraph runs across to the right margin, and so does the second: let $X$ be a value and $T_{A}$ a time, as in the notes above. The last line stops short. {align=justify before=12 after=0}\n\n1\\.&#9;The first item is long enough to run over onto a second line, which starts where its text does. {left=10 hanging=0.194 align=justify tabs=\"24:left\" before=12 after=0}\n\n(a)&#9;A lettered part of the item. {left=34 hanging=0.306 tabs=\"56:left\" before=6 after=0}\n\n∙&#9;A bulleted point. {left=24 hanging=0.167 tabs=\"36:left\" before=6 after=0}\n\nFind $\\dfrac{a}{b}$. {before=12 after=0}\n\n**Question:** {before=22 after=0}\n\nWhat is the chance of more than sixty heads? {.box border-width=0.4 border-space=3.8 border-space-top=0 border-space-bottom=1.6 left=4 before=2.6 after=0}\n\nExplain your answer. {.box border-width=0.4 border-space=3.8 border-space-top=0 border-space-bottom=1.6 left=4 before=0 after=0}\n\n$$\n\\mathbb{P}(X=k)=p\n$$ {before=23 after=0}";

describe("a PDF with everything course notes have", () => {
  it("finds its running header (parts in their own sizes, a rule), page numbers and margins", async () => {
    const { summary } = await analyzeFeatures();
    assert.deepEqual(summary.header?.parts, ["Course 101, Fall Term", "Week 1: Sample Notes", "DEPT 100/200"]);
    assert.deepEqual(summary.header?.partSizes, [10, 12, 10]);
    assert.equal(summary.headerRule, true);
    assert.deepEqual(summary.pageNumbers, { position: "footer", align: "center", y: 752 });
    assert.equal(summary.bodyFont, "CMR12");
    assert.equal(summary.margins.left, 1);
    assert.equal(summary.margins.right, 1);
  });

  it("drafts each page exactly: heading, tab stops, justified text with math, lists, a fraction, a frame, a displayed equation", async () => {
    const { pages, summary } = await analyzeFeatures();
    const first = draft(pages[0]!, summary);
    assert.equal(first.markdown, PAGE_ONE);
    assert.deepEqual(first.needs, []);
    assert.equal(draft(pages[1]!, summary).markdown, "The second page holds one more short paragraph. {before=0 after=0}");
  });

  it("reads back as the document it describes", async () => {
    const { pages, summary } = await analyzeFeatures();
    const blocks = parseMarkdown(draft(pages[0]!, summary).markdown);
    const types = blocks.map((node) => node.type.name);
    assert.equal(types[0], "heading");
    assert.equal(blocks[0]!.textContent, "1\u2003Sample Section");
    assert.ok(blocks[0]!.firstChild!.marks.some((mark) => mark.type.name === "bold"));
    const paragraph = blocks.find((node) => node.textContent.startsWith("The first line"))!;
    assert.equal(paragraph.attrs.align, "justify");
    const math: string[] = [];
    paragraph.forEach((child) => {
      if (child.marks.some((mark) => mark.type.name === "math")) math.push(child.text!);
    });
    assert.deepEqual(math, ["X", "T_{A}"]);
    const framed = blocks.filter((node) => node.attrs.borders?.left);
    assert.deepEqual(
      framed.map((node) => node.textContent),
      ["What is the chance of more than sixty heads?", "Explain your answer."],
    );
    assert.equal(blocks.filter((node) => node.type.name === "code_block").length, 1);
    const item = blocks.find((node) => node.textContent.startsWith("1."))!;
    assert.equal(item.attrs.textIndent, -0.194);
    assert.deepEqual(item.attrs.tabs, [{ pos: 24, align: "left" }]);
  });
});

describe("a notebook page", () => {
  /** A code cell in a gray frame (keywords bold), a cell the page's top edge cuts, and a heading set large but not bold. */
  async function notebook() {
    const content = [
      // A cell running on from the page before: upright lines from off the page, a rule across their foot.
      "0.878 0.878 0.878 RG 0.5 w 96 800 m 96 740 l S 300 800 m 300 740 l S 96 740 m 300 740 l S",
      "BT /F3 10 Tf 100 750 Td (draw\\(\\)) Tj ET",
      "BT /F1 20 Tf 100 700 Td (Problem 1.1) Tj ET",
      "0.878 0.878 0.878 RG 0.5 w 96 636 m 300 636 l 300 680 l 96 680 l h S",
      "BT /F4 10 Tf 100 668 Td (def) Tj ET",
      "BT /F3 10 Tf 120 668 Td (f\\(\\):) Tj ET",
      "BT /F4 10 Tf 120 656 Td (return) Tj ET",
      "BT /F3 10 Tf 155 656 Td (1) Tj ET",
    ].join("\n");
    const pdf = await getDocument({ data: buildTestPdf([{ content }], { F3: "Courier", F4: "Courier-Bold" }), verbosity: 0, fontExtraProperties: true, useSystemFonts: false }).promise;
    const page = await analyzePage(pdf, await pdf.getPage(1), OPS as never);
    return { page, summary: summarize([page.analysis]) };
  }

  it("drafts a code cell as one paragraph of its lines, a cut frame open on its cut side, and a large heading as a heading", async () => {
    const { page, summary } = await notebook();
    const markdown = draftPage({
      page: page.analysis,
      summary,
      area: { left: 100, top: 36, width: 400 },
      fontSize: 10,
      lineSpacing: 1.2,
      family: "Courier",
      fonts: {},
      crops: [],
      color: (run) => (run.bold ? "#008000" : "#000000"),
    }).markdown;
    const blocks = markdown.split("\n\n");
    assert.match(blocks[0]!, /^draw\(\) \{border="left right bottom" border-width=0\.5 .*border-color=#e0e0e0/);
    assert.match(blocks[1]!, /^# Problem 1\.1 \{size=20 /);
    const cell = blocks.find((block) => block.includes("def"))!;
    // Most of its letters are green: the cell is, and the black ones say so.
    assert.match(cell, /^\*\*def\*\* <span style="color: #000000">f\(\):<\/span><br>    \*\*return\*\* <span style="color: #000000">1<\/span> \{\.box /);
    assert.match(cell, /border-color=#e0e0e0 color=#008000 /);
    const [node] = parseMarkdown(cell);
    assert.equal(node!.textContent, "def f():    return 1");
  });
});

describe("emphasis Markdown can't mark", () => {
  it("is written as HTML tags, which parse back as bold", () => {
    const { markdown } = draftPage({
      page: {
        page: 1,
        width: 612,
        height: 792,
        lines: [
          {
            text: "x=1",
            box: { x: 100, y: 92, width: 15, height: 10 },
            baseline: 100,
            size: 10,
            font: "Courier",
            bold: false,
            italic: false,
            runs: [
              { text: "x", x: 100, width: 5, size: 10, font: "Courier", bold: false, italic: false },
              { text: "=", x: 105, width: 5, size: 10, font: "Courier-Bold", bold: true, italic: false },
              { text: "1", x: 110, width: 5, size: 10, font: "Courier", bold: false, italic: false },
            ],
          },
        ],
        images: [],
        links: [],
        rules: [],
        graphics: [],
        ink: { count: 0, box: null, kinds: [], notes: [] },
        scanned: false,
      },
      summary: { margins: { top: 0.5, right: 1, bottom: 1, left: 1.39 }, bodyFont: "Courier", bodySize: 10, lineSpacing: 1.2, paragraphSpacing: 0, header: null, footer: null, pageNumbers: null, fonts: [], headerRule: false },
      area: { left: 100, top: 36, width: 400 },
      fontSize: 10,
      lineSpacing: 1.2,
      family: "Courier",
      fonts: {},
      crops: [],
    });
    assert.match(markdown, /^x<strong>=<\/strong>1 \{/);
    const [node] = parseMarkdown(markdown);
    assert.ok(node!.child(1).marks.some((mark) => mark.type.name === "bold"));
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { parseMarkdown } from "@/lib/doc/markdown";
import { analyzePage, settleInk, summarize, type AnalyzedPage } from "./analyze";
import { draftPage, type DraftContext } from "./draft";
import { featureTestPdf } from "./testPdf";

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

const PAGE_ONE = "## **1&emsp;Sample Section** {size=14.4 color=#000000 before=0 after=0}\n\nQuestions&#9;<span style=\"font-family: 'CMR10 (notes)'; font-size: 10pt\">1</span> {tabs=\"468:right\" before=10 after=0}\n\nThe first line of a justified paragraph runs across to the right margin, and so does the second: let $X$ be a value and $T_{A}$ a time, as in the notes above. The last line stops short. {align=justify before=12 after=0}\n\n1\\.&#9;The first item is long enough to run over onto a second line, which starts where its text does. {left=10 hanging=0.194 align=justify tabs=\"24:left\" before=12 after=0}\n\n(a)&#9;A lettered part of the item. {left=34 hanging=0.306 tabs=\"56:left\" before=6 after=0}\n\n∙&#9;A bulleted point. {left=24 hanging=0.167 tabs=\"36:left\" before=6 after=0}\n\nFind $\\dfrac{a}{b}$. {before=12 after=0}\n\n**Question:** {before=22 after=0}\n\nWhat is the chance of more than sixty heads? {.box border-width=0.4 border-space=3.8 border-space-top=0 border-space-bottom=1.6 left=4 before=3 after=0}\n\nExplain your answer. {.box border-width=0.4 border-space=3.8 border-space-top=0 border-space-bottom=1.6 left=4 before=0 after=0}\n\n$$\n\\mathbb{P}(X=k)=p\n$$ {before=25 after=0}";

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

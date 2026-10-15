import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { analyzePage, settleInk, summarize, type AnalyzedPage } from "./analyze";
import { classifyOperators, looksHandDrawn, pathShape } from "./classify";

/**
 * A small PDF written by hand: each page's content stream as given, Helvetica
 * as the font, and optional annotations (with their own appearance streams).
 */
function buildTestPdf(pages: Array<{ content: string; annots?: string[] }>) {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const stream = (text: string, dict = "") => `<< ${dict} /Length ${Buffer.byteLength(text, "latin1")} >>\nstream\n${text}\nendstream`;
  const catalog = add("");
  const pagesId = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const gstate = add("<< /Type /ExtGState /ca 0.35 /CA 0.35 >>");
  const kids: number[] = [];
  for (const page of pages) {
    const content = add(stream(page.content));
    const annots = (page.annots ?? []).map((annot) => add(annot));
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> /ExtGState << /GS1 ${gstate} 0 R >> >>${annots.length ? ` /Annots [${annots.map((id) => `${id} 0 R`).join(" ")}]` : ""} >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

const BODY = [
  "BT /F2 16 Tf 72 720 Td (Running header) Tj ET",
  "0 0 0 RG 0.5 w 72 712 m 540 712 l S",
  "BT /F2 14 Tf 72 680 Td (1 Introduction) Tj ET",
  "BT /F1 11 Tf 72 660 Td (The first line of the body text runs across the page width here.) Tj ET",
  "BT /F1 11 Tf 72 646 Td (A second line follows it at the same spacing as before.) Tj ET",
  "BT /F1 11 Tf 72 632 Td (A third line ends the paragraph.) Tj ET",
  "BT /F1 11 Tf 300 40 Td (PAGENO) Tj ET",
  // A frame drawn after all the text, as TeX's \\fbox can be: the document's, not ink.
  "0 0 0 RG 0.4 w 70 620 m 545 620 l 545 690 l 70 690 l h S",
].join("\n");

/** A pen stroke: a wiggly filled outline in blue, drawn after the page's text. */
const PEN = "0 0.44 1 rg 100 500 m 110 520 120 480 130 500 c 140 520 150 480 160 500 c 170 520 180 480 190 500 c 190 503 l 180 483 170 523 160 503 c 150 483 140 523 130 503 c 120 483 110 523 100 503 c h f";
/** A translucent yellow highlighter mark over the second line. */
const HIGHLIGHTER = "q /GS1 gs 1 0.9 0 rg 72 643 250 14 re f Q";
/** A logo: the same curvy shape in the same place on every page, drawn last. */
const LOGO = "0.8 0.1 0.1 rg 560 760 m 570 780 580 740 590 760 c 600 780 610 740 600 770 c 580 790 560 770 560 760 c h f";

describe("pathShape and looksHandDrawn", () => {
  it("counts segments and curves and tells straight shapes from drawn ones", () => {
    const rect = pathShape([0, 0, 0, 1, 10, 0, 1, 10, 10, 1, 0, 10, 4]);
    assert.deepEqual({ segments: rect.segments, curves: rect.curves, rectilinear: rect.rectilinear }, { segments: 3, curves: 0, rectilinear: true });
    const curve = pathShape([0, 0, 0, 2, 1, 2, 3, 4, 5, 6, 2, 7, 8, 9, 10, 11, 12, 2, 1, 1, 1, 1, 1, 1]);
    assert.equal(curve.curves, 3);
    const base = { box: { x: 0, y: 0, width: 10, height: 10 }, lineWidth: 1, stroke: false, alpha: 1, color: "#000000" };
    assert.equal(looksHandDrawn({ ...base, ...rect }), false);
    assert.equal(looksHandDrawn({ ...base, ...curve }), true);
    assert.equal(looksHandDrawn({ ...base, ...rect, alpha: 0.4 }), true, "a translucent box is a highlighter");
  });
});

describe("classifyOperators", () => {
  it("leaves paths drawn before the last text as content", () => {
    const list = {
      fnArray: [OPS.constructPath, OPS.showText],
      argsArray: [[OPS.fill, [new Float32Array([0, 0, 0, 2, 1, 2, 3, 4, 5, 6, 2, 7, 8, 9, 10, 11, 12, 2, 1, 1, 1, 1, 1, 1])], new Float32Array([0, 0, 12, 12])], [[]]],
    };
    const result = classifyOperators(list, OPS as never, { viewport: [1, 0, 0, -1, 0, 792], pageWidth: 612, pageHeight: 792 });
    assert.deepEqual(result.classes, ["content", "content"]);
    assert.equal(result.contentEnd, 1);
  });
});

async function analyze(data: Uint8Array) {
  const pdf = await getDocument({ data, verbosity: 0, fontExtraProperties: true, useSystemFonts: false }).promise;
  const pages: AnalyzedPage[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) pages.push(await analyzePage(pdf, await pdf.getPage(number), OPS as never));
  return pages;
}

describe("analyzePage", () => {
  it("separates pen strokes and highlighting drawn over a page from the page itself", async () => {
    const [page] = await analyze(buildTestPdf([{ content: `${BODY.replace("PAGENO", "1")}\n${PEN}\n${HIGHLIGHTER}` }]));
    const { analysis, classification } = page!;
    assert.equal(analysis.ink.count, 2);
    assert.deepEqual(analysis.ink.kinds.sort(), ["highlighter", "pen"]);
    // The frame drawn after the text is the page's own, and is found as a frame.
    assert.ok(analysis.rules.some((rule) => rule.kind === "frame" && Math.abs(rule.box.x - 70) < 1 && Math.abs(rule.box.width - 475) < 1));
    assert.ok(analysis.rules.some((rule) => rule.kind === "hline" && Math.abs(rule.box.y - 80) < 1));
    // Every operator is either the page's or the ink's, never both.
    const ink = classification.classes.filter((kind) => kind === "ink").length;
    assert.equal(ink, 2);
    assert.ok(analysis.ink.box && analysis.ink.box.y > 130 && analysis.ink.box.y < 300);
  });

  it("reads lines of text with their fonts, sizes and positions", async () => {
    const [page] = await analyze(buildTestPdf([{ content: BODY.replace("PAGENO", "1") }]));
    const lines = page!.analysis.lines;
    const heading = lines.find((line) => line.text === "1 Introduction")!;
    assert.equal(heading.bold, true);
    assert.equal(heading.size, 14);
    assert.equal(heading.baseline, 112);
    const body = lines.find((line) => line.text.startsWith("The first line"))!;
    assert.equal(body.font, "Helvetica");
    assert.equal(body.bold, false);
    assert.equal(body.box.x, 72);
    assert.equal(page!.analysis.ink.count, 0);
  });

  it("treats a drawing repeated in the same place on every page as the document's", async () => {
    const pages = await analyze(
      buildTestPdf([
        { content: `${BODY.replace("PAGENO", "1")}\n${LOGO}` },
        { content: `${BODY.replace("PAGENO", "2")}\n${LOGO}\n${PEN}` },
      ]),
    );
    assert.equal(pages[0]!.analysis.ink.count, 1);
    settleInk(pages);
    assert.equal(pages[0]!.analysis.ink.count, 0);
    assert.equal(pages[1]!.analysis.ink.count, 1, "the pen stroke on page 2 is still ink");
  });

  it("takes PDF markup annotations for ink, but not links", async () => {
    const [page] = await analyze(withInkAnnotation("0 0 1 RG 2 w 0 0 m 30 20 l 60 0 l S"));
    const { analysis } = page!;
    assert.equal(analysis.links.length, 1);
    assert.equal(analysis.links[0]!.url, "https://example.com/");
    assert.match(analysis.links[0]!.text ?? "", /The first line/);
    assert.ok(analysis.ink.kinds.includes("Ink"));
    assert.deepEqual(
      analysis.ink.notes.map((note) => [note.kind, note.text]),
      [["Ink", "Check this"]],
    );
  });
});

/** A page with an ink annotation (its appearance an object of its own, added as an update) and a link. */
function withInkAnnotation(ap: string) {
  const annots = [
    `<< /Type /Annot /Subtype /Ink /Rect [100 300 160 320] /InkList [[100 300 130 320 160 300]] /Contents (Check this) /AP << /N APOBJ >> >>`,
    "<< /Type /Annot /Subtype /Link /Rect [72 655 200 670] /A << /S /URI /URI (https://example.com/) >> >>",
  ];
  const appearance = `<< /Type /XObject /Subtype /Form /BBox [0 0 60 20] /Length ${ap.length} >>\nstream\n${ap}\nendstream`;
  // Objects: 1 catalog, 2 pages, 3-5 fonts and state, 6 content, 7-8 annots, 9 page, 10 appearance.
  const built = buildTestPdf([{ content: BODY.replace("PAGENO", "1"), annots: annots.map((annot) => annot.replace("APOBJ", "10 0 R")) }]);
  let out = Buffer.from(built).toString("latin1");
  // Append the appearance as object 10 with an incremental update.
  const start = Buffer.byteLength(out, "latin1");
  const prevXref = Number(/startxref\n(\d+)/.exec(out)![1]);
  out += `10 0 obj\n${appearance}\nendobj\n`;
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n10 1\n${String(start).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 11 /Root 1 0 R /Prev ${prevXref} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

describe("summarize", () => {
  it("finds the running header, the page numbers, the margins and the main font", async () => {
    const pages = await analyze(buildTestPdf([1, 2, 3].map((n) => ({ content: BODY.replace("PAGENO", String(n)) }))));
    const summary = summarize(pages.map((page) => page.analysis));
    assert.equal(summary.header?.text, "Running header");
    assert.deepEqual(summary.pageNumbers, { position: "footer", align: "center" });
    assert.equal(summary.bodyFont, "Helvetica");
    assert.equal(summary.bodySize, 11);
    assert.equal(summary.lineSpacing, round(14 / 11));
    assert.equal(summary.margins.left, 1);
    assert.equal(summary.headerRule, true);
  });
});

function round(value: number) {
  return Math.round(value * 100) / 100;
}

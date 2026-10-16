import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PdfTextLine } from "@/lib/pdf/import/types";
import { compareLines, coverMath, formatMatch, innerMathNote, planAlignment, type BlockSpacing } from "./pdfAlign";
import { frameWidthError, originalExtent, originalExtentSentence, uncomparedMessage, uncomparedPages } from "./pdfTools";

const line = (text: string, baseline: number, x = 72): PdfTextLine => ({ text, baseline, box: { x, y: baseline - 9, width: 200, height: 12 }, size: 12, font: "MathJax_Main", bold: false, italic: false, runs: [] });

describe("equation lines inside a math block", () => {
  const lines = [line("Let V be", 100), line("2", 150), line("−1", 166), line("V = {v ∈ R2 : x > 0}", 190), line("as defined", 230)];
  const rendered = [
    { x: 72, y: 101, size: 12, text: "Let V be" },
    { x: 72, y: 231, size: 12, text: "as defined" },
  ];
  // Glyph boxes run from y 141 to 193 (center 167). A block centered there matches; one 6 pt lower does not.
  const matched = { id: "eq", top: 140, bottom: 194, text: "V = \\{v \\in R^2\\}" };
  const low = { ...matched, top: 146, bottom: 200 };

  it("says the glyphs are inside the math block, not missing, and whether the equation sits right", () => {
    const covered = coverMath(compareLines(lines, rendered), lines, [matched]);
    const math = covered.matches.filter((row) => row.math);
    assert.deepEqual(
      math.map((row) => row.text),
      ["2", "−1", "V = {v ∈ R2 : x > 0}"],
    );
    for (const row of math) {
      const report = formatMatch(row);
      assert.match(report, /in math/);
      assert.match(report, /inside the math block "V = \\{v \\in R\^2\\}"/);
      assert.match(report, /not missing text/);
      assert.match(report, /the equation's position matches/);
      assert.doesNotMatch(report, /missing {2}"/);
    }
    const prose = covered.matches.find((row) => row.text === "Let V be")!;
    assert.equal(prose.math, undefined);
    assert.match(formatMatch(prose), /101/);

    const shifted = coverMath(compareLines(lines, rendered), lines, [low]);
    const lower = formatMatch(shifted.matches.find((row) => row.text === "−1")!);
    assert.match(lower, /in math/);
    assert.match(lower, /not missing text/);
    assert.match(lower, /the equation is \+6\.0 pt from where it should be/);
    assert.equal(shifted.matches.find((row) => row.text === "−1")!.math!.offset, 6);
  });

  it("moves an unmatched math block onto the equation", () => {
    const glyphs = [line("2", 150), line("−1", 166), line("V = {v ∈ R2 : x > 0}", 190)];
    const covered = coverMath(compareLines(glyphs, []), glyphs, [low]);
    const spacing: BlockSpacing = { spaceBefore: 12, spaceAfter: 0, canBefore: true, canAfter: true };
    const plan = planAlignment(glyphs, [], [{ id: "eq", top: 146, bottom: 200 }], () => spacing, 0.75, covered.anchors);
    // The equation is 6 pt low and has 12 pt above it, so the space above becomes 6.
    assert.equal(plan.changes.get("eq")?.spaceBefore, 6);
  });

  it("names the math block and the row gap when the first line already matches", () => {
    const note = innerMathNote("−1", 6, "\\begin{bmatrix} 1 \\\\ -1 \\end{bmatrix}");
    assert.match(note, /inside the math block "\\begin\{bmatrix\}/);
    assert.match(note, /\+6\.0 pt/);
    assert.match(note, /before= cannot move this line/);
    assert.match(note, /\\\\\[6pt\]/);
    assert.match(note, /not line=/);
    assert.doesNotMatch(note, /line spacing inside the block/);
  });
});

describe("finish_pdf_import", () => {
  it("refuses until every page has been compared and names the pages left", () => {
    assert.deepEqual(uncomparedPages(7, [1, 2, 6, 7]), [3, 4, 5]);
    const message = uncomparedMessage([3, 4, 5]);
    assert.match(message, /Pages 3-5 haven't been compared/);
    assert.match(message, /compare_pdf_page each of them before finish_pdf_import/);
    assert.equal(uncomparedPages(2, [1, 2]).length, 0);
  });
});

describe("a frame wider than the text", () => {
  it("says the frame cannot extend past the text width", () => {
    const message = frameWidthError('print(x) {.box border-width=0.4 border-space=3 border-space-right=66 font="Menlo"}');
    assert.ok(message);
    assert.match(message!, /cannot extend past the text width/);
    assert.match(message!, /border-space-right=66/);
    assert.match(message!, /The page was not changed/);
    assert.doesNotMatch(message!, /already has this content/);
    assert.equal(frameWidthError('print(x) {.box border-width=0.4 border-space=3 border-space-right=40}'), null);
  });
});

describe("a frame continued from the previous page", () => {
  it("does not say the original content starts at the top edge", () => {
    const extent = originalExtent({
      height: 792,
      lines: [{ box: { x: 72, y: 80, width: 200, height: 12 } }],
      images: [],
      rules: [{ kind: "frame", box: { x: 60, y: 0, width: 460.8, height: 220 } }],
    });
    assert.equal(extent?.continuation, true);
    assert.equal(extent?.top, 80);
    const sentence = originalExtentSentence(extent!);
    assert.match(sentence, /continues from the previous page/);
    assert.match(sentence, /clipped at the top edge/);
    assert.match(sentence, /not where the page's content starts/);
    assert.match(sentence, /from 80\.0 to /);
    assert.doesNotMatch(sentence, /from 0\.0/);
  });
});

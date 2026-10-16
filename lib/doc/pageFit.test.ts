import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyFit, countLines, predictFitHeight, solveFit, type FitMeasurement, type FitUnit, type FitWord } from "@/lib/doc/pageFit";
import { schema } from "@/lib/doc/schema";

const PAGE = 864;

function words(count: number, width: number, gap: number): FitWord[] {
  return Array.from({ length: count }, () => ({ width, gap }));
}

function paragraph(partial: Partial<FitUnit> & { pos: number }): FitUnit {
  const width = partial.width ?? 640;
  const list = partial.words ?? words(40, 36, 8);
  const lines = partial.lines ?? countLines(list, width, partial.indent ?? 0);
  return {
    kind: "text",
    gapBefore: 0,
    gapScales: true,
    lineHeight: 18,
    fontSize: 11,
    lineSpacing: 1.15,
    width,
    indent: 0,
    words: list,
    marks: [],
    canSize: true,
    canLead: true,
    canSpace: true,
    spaceBeforePt: 0,
    spaceAfterPt: 8,
    ...partial,
    lines,
  };
}

function measurement(units: FitUnit[], body: Partial<FitMeasurement> = {}): FitMeasurement {
  return { version: 1, fromPage: 1, toPage: 1, targetPages: 0.5, pageContentHeight: PAGE, bodyFontSize: 11, bodyLineSpacing: 1.15, units, ...body };
}

describe("line count", () => {
  test("wraps when the next word does not fit", () => {
    const list = words(4, 40, 10);
    assert.equal(countLines(list, 100), 2);
    assert.equal(countLines(list, 100, 30), 3);
  });

  test("a hard break starts a line", () => {
    assert.equal(countLines([{ width: 20, gap: 0 }, { width: 20, gap: 0, breakBefore: true }], 200), 2);
  });
});

describe("fit math", () => {
  test("a partly empty page is scaled from what it fills, not from a full page", () => {
    const units = [paragraph({ pos: 0, words: words(400, 40, 8), lineHeight: 20, gapBefore: 0 })];
    const occupied = predictFitHeight(units, 1, 1, 1);
    assert.ok(occupied > PAGE * 0.55 && occupied < PAGE * 0.9, `occupied ${occupied}`);
    const fitted = solveFit(measurement(units));
    assert.equal(fitted.blocked, null);
    assert.equal(fitted.unchanged, false);
    assert.ok(fitted.height <= PAGE / 2 + 0.5, `height ${fitted.height}`);
    assert.ok(fitted.height > PAGE / 2 * 0.75, `over-shrunk to ${fitted.height}`);
    // Treating the page as full would scale toward half of a full page, a much smaller font.
    const naive = solveFit(measurement([paragraph({ pos: 0, words: words(700, 40, 8), lineHeight: 20 })]));
    assert.ok(fitted.bodyFontSize > naive.bodyFontSize, `${fitted.bodyFontSize} should stay larger than a full-page squeeze (${naive.bodyFontSize})`);
    assert.equal(fitted.spacingScale, 1);
    assert.match(fitted.summary, /Body text is [\d.]+pt with line spacing [\d.]+/);
  });

  test("two pages with a short second page are not squeezed as two full pages", () => {
    const first = paragraph({ pos: 0, words: words(500, 40, 8), lineHeight: 20 });
    const second = paragraph({ pos: 20, words: words(200, 40, 8), lineHeight: 20, gapBefore: 12 });
    const units = [first, second];
    const occupied = predictFitHeight(units, 1, 1, 1);
    assert.ok(occupied > PAGE && occupied < PAGE * 1.7, `occupied ${occupied}`);
    const fitted = solveFit(measurement(units, { toPage: 2, targetPages: 1 }));
    assert.equal(fitted.blocked, null);
    assert.ok(fitted.height <= PAGE + 0.5, `height ${fitted.height}`);
    assert.ok(fitted.height > PAGE * 0.8, `over-shrunk to ${fitted.height}`);
    const bothFull = solveFit(
      measurement([
        paragraph({ pos: 0, words: words(500, 40, 8), lineHeight: 20 }),
        paragraph({ pos: 20, words: words(500, 40, 8), lineHeight: 20, gapBefore: 12 }),
      ], { toPage: 2, targetPages: 1 }),
    );
    assert.ok(fitted.bodyFontSize > bothFull.bodyFontSize);
  });

  test("content already inside the target is left alone", () => {
    const units = [paragraph({ pos: 0, words: words(8, 30, 6), lineHeight: 18 })];
    const occupied = predictFitHeight(units, 1, 1, 1);
    assert.ok(occupied < PAGE / 2);
    const fitted = solveFit(measurement(units));
    assert.equal(fitted.unchanged, true);
    assert.equal(fitted.blocked, null);
    assert.equal(fitted.blocks.length, 0);
    assert.match(fitted.summary, /already fits/);
  });

  test("line spacing tightens when the font cannot get small enough", () => {
    const units = Array.from({ length: 50 }, (_, index) =>
      paragraph({ pos: index, words: words(1, 20, 0), lineHeight: 22, fontSize: 11, lineSpacing: 1.15, gapBefore: 0, spaceAfterPt: 0 }),
    );
    const atMinFont = predictFitHeight(units, 6 / 11, 1, 1);
    assert.ok(atMinFont > PAGE / 2, `min font still ${atMinFont}`);
    const fitted = solveFit(measurement(units));
    assert.equal(fitted.blocked, null);
    assert.ok(fitted.bodyFontSize <= 6.05);
    assert.ok(fitted.bodyLineSpacing < 1.15);
    assert.ok(fitted.bodyLineSpacing >= 0.8);
    assert.equal(fitted.spacingScale, 1);
    assert.ok(fitted.height <= PAGE / 2 + 0.5);
  });

  test("paragraph spacing is reduced only after font and line spacing are exhausted", () => {
    const units = Array.from({ length: 24 }, (_, index) =>
      paragraph({
        pos: index,
        words: words(1, 20, 0),
        lineHeight: 20,
        gapBefore: index === 0 ? 0 : 28,
        gapScales: true,
        spaceBeforePt: index === 0 ? 0 : 20,
        spaceAfterPt: 20,
      }),
    );
    const typeOnly = predictFitHeight(units, 6 / 11, 0.8 / 1.15, 1);
    assert.ok(typeOnly > PAGE / 2);
    const fitted = solveFit(measurement(units));
    assert.equal(fitted.blocked, null);
    assert.ok(fitted.spacingScale < 1);
    assert.ok(fitted.bodyFontSize <= 6.05);
    assert.ok(fitted.bodyLineSpacing <= 0.8 + 0.001);
    assert.ok(fitted.height <= PAGE / 2 + 0.5);
    assert.ok(fitted.blocks.some((block) => block.spaceAfter != null && block.spaceAfter < 20));
    assert.match(fitted.summary, /Paragraph spacing/);
  });

  test("a page break in the range is reported and not removed", () => {
    const units = [
      paragraph({ pos: 0, words: words(80, 40, 8), lineHeight: 20 }),
      { pos: 10, kind: "break" as const, gapBefore: 0 },
      paragraph({ pos: 12, words: words(80, 40, 8), lineHeight: 20, gapBefore: 14 }),
    ];
    const fitted = solveFit(measurement(units, { toPage: 2, targetPages: 1 }));
    assert.match(fitted.blocked ?? "", /page break/);
    assert.equal(fitted.blocks.length, 0);
  });

  test("headings and manual sizes in the range scale together", () => {
    const body = paragraph({ pos: 0, words: words(400, 40, 8), lineHeight: 20, fontSize: 11 });
    const heading = paragraph({ pos: 30, words: words(8, 50, 8), lineHeight: 28, fontSize: 20, lineSpacing: 1.2, gapBefore: 16, marks: [{ from: 0, to: 4, size: 20 }] });
    const fitted = solveFit(measurement([body, heading]));
    assert.equal(fitted.blocked, null);
    const headingPlan = fitted.blocks.find((block) => block.pos === 30);
    const bodyPlan = fitted.blocks.find((block) => block.pos === 0);
    assert.ok(bodyPlan?.fontSize);
    assert.ok(headingPlan?.fontSize);
    assert.ok(Math.abs(headingPlan!.fontSize! / 20 - bodyPlan!.fontSize! / 11) < 0.02);
    assert.equal(headingPlan?.marks.length, 1);
    assert.ok(Math.abs(headingPlan!.marks[0]!.size / 20 - headingPlan!.fontSize! / 20) < 0.02);
  });
});

describe("apply fit", () => {
  test("writes direct formatting on the fitted blocks and leaves styles and later text alone", () => {
    const big = schema.mark("font_size", { size: "16pt" });
    const later = schema.mark("font_size", { size: "20pt" });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", { id: "a", style: "Callout" }, [schema.text("Hello "), schema.text("wide", [big])]),
      schema.node("paragraph", { id: "b", style: "Callout", fontSize: 18 }, [schema.text("Later", [later])]),
    ]);
    let second = -1;
    doc.forEach((node, pos) => {
      if (node.attrs.id === "b") second = pos;
    });
    const units = [
      paragraph({
        pos: 0,
        fontSize: 11,
        words: words(400, 40, 8),
        lineHeight: 20,
        marks: [{ from: 6, to: 10, size: 16 }],
      }),
    ];
    const fitted = solveFit(measurement(units));
    assert.equal(fitted.unchanged, false);
    const next = applyFit(doc, fitted).doc;
    const first = next.firstChild!;
    const rest = next.child(1);
    assert.equal(first.attrs.style, "Callout");
    assert.equal(rest.attrs.style, "Callout");
    assert.equal(rest.attrs.fontSize, 18);
    assert.notEqual(first.attrs.fontSize, null);
    assert.ok(first.attrs.fontSize < 11);
    assert.equal(rest.textContent, "Later");
    const kept = rest.firstChild!;
    assert.equal(kept.marks.find((mark) => mark.type.name === "font_size")?.attrs.size, "20pt");
    const scaled = first.child(1)!;
    assert.notEqual(scaled.marks.find((mark) => mark.type.name === "font_size")?.attrs.size, "16pt");
    assert.equal(second > 0, true);
    assert.equal(next.child(1).attrs.fontSize, 18);
  });
});

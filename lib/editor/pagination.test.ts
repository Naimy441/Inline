import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canvasHeadingShouldMove, pageGapCovers, preferredBreak, sharesLine } from "./pagination";

describe("line grouping", () => {
  it("keeps two lines apart when tall script boxes only touch them", () => {
    // Arabic at 30px: each content box is 40px, and the next line starts 34px lower.
    assert.equal(sharesLine({ top: 248, bottom: 288 }, 282, 322), false);
  });

  it("joins fragments of one line whatever their size", () => {
    // A larger inline word on the same line: its box covers the smaller one.
    assert.equal(sharesLine({ top: 240, bottom: 290 }, 256, 274), true);
    // Two fragments that differ by a pixel or two (rounding) are still one line.
    assert.equal(sharesLine({ top: 100, bottom: 118 }, 101, 119), true);
  });
});

describe("line breaks", () => {
  it("splits where the line overflows when widow control is off", () => {
    assert.equal(preferredBreak(3, 6, true, false, false), 3);
  });

  it("keeps a paragraph together when a split would leave one line", () => {
    assert.equal(preferredBreak(1, 4, true, true, false), 0);
    assert.equal(preferredBreak(3, 4, true, true, false), 0);
  });

  it("moves the last two lines when the paragraph is taller than a page", () => {
    assert.equal(preferredBreak(5, 6, false, true, false), 4);
  });

  it("keeps every line of a paragraph that fits on the next page", () => {
    assert.equal(preferredBreak(2, 4, true, false, true), 0);
  });

  it("leaves a split that already has two lines on each side", () => {
    assert.equal(preferredBreak(2, 6, true, true, false), 2);
  });
});

describe("canvas page breaks", () => {
  const geometry = { pageHeight: 1000, marginTop: 100, marginBottom: 100, gap: 40 };

  it("covers the margins with paper and the sheet gap with the desk", () => {
    // Spacer from content y 700 to the next page's content at 1040.
    const covers = pageGapCovers(700, 340, geometry);
    assert.deepEqual(covers, [
      { top: 100, height: 100, kind: "paper" },
      { top: 200, height: 40, kind: "desk" },
      { top: 240, height: 100, kind: "paper" },
    ]);
  });

  it("moves a heading that would leave its following line behind", () => {
    assert.equal(canvasHeadingShouldMove(40, 30, 24, 800), true);
    assert.equal(canvasHeadingShouldMove(200, 30, 24, 800), false);
    assert.equal(canvasHeadingShouldMove(40, 30, 900, 800), false);
  });
});

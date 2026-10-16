import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PdfPageAnalysis, PdfTextLine } from "./types";
import { inkColor, runColors } from "./inkColor";
import { unexplainedMarks } from "./marks";
import { variableWeight, fontStyle } from "./text";

/** A white page of `width` × `height` points at 2 pixels a point, with boxes painted in colors. */
function bitmap(width: number, height: number, boxes: Array<{ x: number; y: number; width: number; height: number; rgb: [number, number, number] }>) {
  const scale = 2;
  const w = width * scale;
  const h = height * scale;
  const data = new Uint8Array(w * h * 4).fill(255);
  for (const box of boxes) {
    for (let y = box.y * scale; y < (box.y + box.height) * scale; y += 1) {
      for (let x = box.x * scale; x < (box.x + box.width) * scale; x += 1) {
        const i = (y * w + x) * 4;
        [data[i], data[i + 1], data[i + 2]] = box.rgb;
      }
    }
  }
  return { bitmap: { width: w, height: h, data }, scale };
}

const line = (text: string, x: number, baseline: number, runs: Array<{ text: string; x: number; width: number }>): PdfTextLine => ({
  text,
  box: { x, y: baseline - 8, width: 100, height: 10 },
  baseline,
  size: 10,
  font: "Menlo",
  bold: false,
  italic: false,
  runs: runs.map((run) => ({ ...run, size: 10, font: "Menlo", bold: false, italic: false })),
});

describe("text colors read off the page", () => {
  it("finds each run's color, black as black, and one color for near shades", () => {
    const { bitmap: page, scale } = bitmap(200, 60, [
      { x: 10, y: 14, width: 20, height: 6, rgb: [0, 128, 0] },
      { x: 40, y: 14, width: 20, height: 6, rgb: [12, 10, 14] },
      { x: 70, y: 14, width: 4, height: 6, rgb: [0xaa, 0x22, 0xff] },
      { x: 80, y: 14, width: 20, height: 6, rgb: [0xa4, 0x26, 0xf8] },
    ]);
    const text = line("import x = y", 10, 20, [
      { text: "import", x: 10, width: 20 },
      { text: "x", x: 40, width: 20 },
      { text: "=", x: 70, width: 4 },
      { text: "yy", x: 80, width: 20 },
    ]);
    const colors = runColors(page, scale, [text]);
    assert.deepEqual(
      text.runs.map((run) => colors.get(run)),
      ["#008000", "#000000", "#a426f8", "#a426f8"],
    );
    assert.equal(inkColor(page, scale, { x: 150, y: 10, width: 20, height: 20 }), null);
  });
});

describe("marks the text layer doesn't have", () => {
  it("are the inked regions away from text, rules and pictures", () => {
    const { bitmap: page, scale } = bitmap(200, 100, [
      // Text the layer knows.
      { x: 100, y: 14, width: 40, height: 6, rgb: [0, 0, 0] },
      // A label drawn as a picture, left of it: two words close together.
      { x: 40, y: 14, width: 8, height: 6, rgb: [96, 96, 96] },
      { x: 52, y: 14, width: 16, height: 6, rgb: [96, 96, 96] },
      // A frame's side.
      { x: 96, y: 40, width: 1, height: 40, rgb: [224, 224, 224] },
    ]);
    const analysis: PdfPageAnalysis = {
      page: 1,
      width: 200,
      height: 100,
      lines: [line("text", 100, 20, [{ text: "text", x: 100, width: 40 }])],
      images: [],
      links: [],
      rules: [{ kind: "vline", box: { x: 96, y: 40, width: 1, height: 40 }, width: 1, color: "#e0e0e0" }],
      graphics: [],
      ink: { count: 0, box: null, kinds: [], notes: [] },
      scanned: false,
    };
    assert.deepEqual(unexplainedMarks(page, scale, analysis), [{ x: 40, y: 14, width: 28, height: 6 }]);
  });
});

describe("variable font instances", () => {
  it("are as bold as the weight in their name says", () => {
    assert.equal(variableWeight(".SFNS-RegularItalic_opsz110000_YAXS_wght2BC0000"), 700);
    assert.equal(variableWeight(".SFNS-Regular_wdth_opsz110000_GRAD_wght1F40000"), 500);
    assert.equal(variableWeight(".SFNS-Regular_wdth_opsz110000_GRAD_wght"), null);
    assert.equal(fontStyle(".SFNS-RegularItalic_opsz110000_YAXS_wght2BC0000").bold, true);
    assert.equal(fontStyle(".SFNS-Regular_wdth_opsz110000_GRAD_wght1F40000").bold, false);
  });
});

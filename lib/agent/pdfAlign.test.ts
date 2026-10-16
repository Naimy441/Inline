import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PdfTextLine } from "@/lib/pdf/import/types";
import { compareLines, planAlignment, type BlockSpacing } from "./pdfAlign";

const line = (text: string, baseline: number, x = 72): PdfTextLine => ({ text, baseline, box: { x, y: baseline - 9, width: 300, height: 12 }, size: 12, font: "CMR12", bold: false, italic: false, runs: [] });

const original = [line("Normal distribution and density function", 100), line("Binomial distributions look like bell curves", 130), line("A density function is like a histogram", 200)];

describe("compareLines", () => {
  it("matches lines by their words, in order down the page", () => {
    const report = compareLines(original, [
      { x: 72, y: 104, size: 12, text: "Normal distribution and density function" },
      { x: 72, y: 128, size: 12, text: "Binomial distributions look like bell curves." },
      { x: 80, y: 190, size: 12, text: "A density function is like a histogram: the area" },
    ]);
    assert.deepEqual(
      report.map((row) => [row.rendered, row.dx]),
      [
        [104, 0],
        [128, 0],
        [190, 8],
      ],
    );
  });
});

describe("compareLines with lines that share their words", () => {
  it("gives each original line its own rendered line, in order, single letters and all", () => {
    const lines = [line("a = Set(a)", 693.3), line("b = Set(b)", 704.4), line("from minkowski import Set", 730), line("from minkowski import minkowski", 755), line("else:", 780), line("else:", 800)];
    const rendered = [
      { x: 72, y: 693, size: 12, text: "a = Set(a)" },
      { x: 72, y: 704, size: 12, text: "b = Set(b)" },
      { x: 72, y: 731, size: 12, text: "from minkowski import Set" },
      { x: 72, y: 756, size: 12, text: "from minkowski import minkowski" },
      { x: 72, y: 781, size: 12, text: "else:" },
      { x: 72, y: 801, size: 12, text: "else:" },
    ];
    const report = compareLines(lines, rendered);
    assert.deepEqual(
      report.map((row) => row.rendered),
      [693, 704, 731, 756, 781, 801],
    );
    assert.deepEqual(
      report.map((row) => Boolean(row.repeated)),
      [false, false, false, false, true, true],
    );
  });

  it("leaves a line missing rather than reusing a rendered line another took", () => {
    const report = compareLines([line("from minkowski import Set", 100), line("from minkowski import minkowski", 120)], [{ x: 72, y: 101, size: 12, text: "from minkowski import Set" }]);
    assert.deepEqual(
      report.map((row) => row.rendered),
      [101, null],
    );
  });
});

describe("planAlignment", () => {
  const text: BlockSpacing = { spaceBefore: null, spaceAfter: 8, canBefore: true, canAfter: true };
  const rendered = [
    { x: 72, y: 104, size: 12, text: "Normal distribution and density function" },
    { x: 72, y: 128, size: 12, text: "Binomial distributions look like bell curves" },
    { x: 72, y: 190, size: 12, text: "A density function is like a histogram" },
  ];
  const blocks = [
    { id: "a", top: 95, bottom: 108 },
    { id: "b", top: 119, bottom: 132 },
    { id: "c", top: 181, bottom: 194 },
  ];

  it("moves each block onto its line, putting the whole gap above it", () => {
    const plan = planAlignment(original, rendered, blocks, () => text);
    // a, first on the page, is 4 pt low with no space above it to give up. b is 2 pt high: its gap of 11 grows
    // to 13. c is 10 pt high, 8 once b has moved down: its gap of 49 grows to 57.
    assert.deepEqual(Object.fromEntries(plan.changes), {
      a: { spaceBefore: 0, spaceAfter: 0 },
      b: { spaceBefore: 13, spaceAfter: 0 },
      c: { spaceBefore: 57 },
    });
    assert.deepEqual(
      plan.offsets.map((row) => row.offset),
      [4, -2, -10],
    );
  });

  it("moves a block in a shared box by the space inside the box", () => {
    const plan = planAlignment(original, rendered, [blocks[0]!, { ...blocks[1]!, top: 108, joined: true, inside: 6 }, blocks[2]!], () => text);
    // b is 2 pt high: the 6 pt inside the box above it becomes 8.
    assert.deepEqual(plan.changes.get("b"), { spaceBefore: 8, spaceAfter: 0 });
  });

  it("leaves blocks in a box it can't measure, and blocks that can't take spacing, where they are", () => {
    const plan = planAlignment(original, rendered, [blocks[0]!, { ...blocks[1]!, joined: true }, blocks[2]!], (id) => (id === "c" ? { ...text, canBefore: false } : text));
    // b stays in its box; c can't take space above it, so b takes the 10 pt below it: a gap of 49 + 10.
    assert.deepEqual(Object.fromEntries(plan.changes), { a: { spaceBefore: 0 }, b: { spaceAfter: 59 } });
  });

  it("says why a block that spacing can't move is still off", () => {
    // a is 4 pt low with no space above it to give up; c can't take space, nor can b give it, and is 8 pt high once b has moved down 2.
    const plan = planAlignment(original, rendered, blocks, (id) => (id === "a" ? { ...text, spaceBefore: 0 } : id === "c" ? { ...text, canBefore: false } : { ...text, canAfter: false }));
    assert.deepEqual(
      plan.stuck.map((item) => [item.id, item.offset]),
      [
        ["a", 4],
        ["c", -8],
      ],
    );
    assert.match(plan.stuck[0]!.reason, /first block on the page/);
    assert.match(plan.stuck[1]!.reason, /neither it nor the block above/);
  });

  it("changes nothing on a page that already matches", () => {
    const plan = planAlignment(original, [rendered[0]!, rendered[1]!, rendered[2]!].map((row, index) => ({ ...row, y: original[index]!.baseline })), blocks, () => text);
    assert.equal(plan.changes.size, 0);
  });
});

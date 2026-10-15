import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { liveLineBreaks } from "@/lib/doc/lineBreaks";
import { schema } from "@/lib/doc/schema";
import type { PdfTextLine } from "@/lib/pdf/import/types";
import { lineBreaksFor } from "./pdfLines";

/** A PDF line: runs of [text, font], ending at `right`. */
const line = (runs: Array<[string, string]>, baseline: number, right = 540): PdfTextLine => ({
  text: runs.map(([text]) => text).join(""),
  baseline,
  box: { x: 72, y: baseline - 9, width: right - 72, height: 12 },
  size: 10,
  font: "CMR10",
  bold: false,
  italic: false,
  runs: runs.map(([text, font]) => ({ text, font, x: 72, width: 10, size: 10, bold: false, italic: false })),
});

const math = schema.marks.math!.create();
const paragraph = (...pieces: Array<string | [string]>) =>
  schema.nodes.paragraph!.create(
    null,
    pieces.map((piece) => (typeof piece === "string" ? schema.text(piece) : schema.text(piece[0], [math]))),
  );

describe("lineBreaksFor", () => {
  it("breaks before the first word of each full line, past equations that end a line", () => {
    const para = paragraph("A commuter's time spent is distributed with mean ", ["\\mu"], " and standard deviation ", ["\\sigma_1"], ". Another line ends with ", ["X"], " here.");
    const doc = schema.nodes.doc!.create(null, [para]);
    const lines = [
      line([["A commuter's time spent is distributed with mean", "CMR10"]], 100),
      line([["μ", "CMMI10"], [" and standard deviation ", "CMR10"], ["σ1", "CMMI10"], [". Another line ends with ", "CMR10"], ["X", "CMMI10"]], 112),
      line([["here.", "CMR10"]], 124, 100),
    ];
    const [change] = lineBreaksFor(doc, 0, doc.content.size, lines);
    assert.ok(change && change.value);
    const next = doc.nodeAt(change.pos)!.type.create({ ...doc.nodeAt(change.pos)!.attrs, lineBreaks: change.value }, doc.nodeAt(change.pos)!.content);
    const breaks = liveLineBreaks(next)!.breaks;
    const text = next.textContent;
    assert.deepEqual(
      breaks.map((item) => text.slice(item.at, item.at + 6)),
      ["\\mu an", "here."],
    );
  });

  it("breaks inside a word hyphenated at a line's end", () => {
    const para = paragraph("We use the normal approximation to estimate it now.");
    const doc = schema.nodes.doc!.create(null, [para]);
    const lines = [line([["We use the normal approxi-", "CMR10"]], 100), line([["mation to estimate it now.", "CMR10"]], 112, 300)];
    const [change] = lineBreaksFor(doc, 0, doc.content.size, lines);
    const breaks = liveLineBreaks(para.type.create({ lineBreaks: change!.value }, para.content))!.breaks;
    assert.deepEqual(breaks, [{ at: "We use the normal approxi".length, hyphen: true }]);
  });

  it("holds no breaks once the text changes", () => {
    const para = paragraph("One two three four five six seven eight nine ten.");
    const doc = schema.nodes.doc!.create(null, [para]);
    const [change] = lineBreaksFor(doc, 0, doc.content.size, [line([["One two three four five", "CMR10"]], 100), line([["six seven eight nine ten.", "CMR10"]], 112, 200)]);
    assert.ok(liveLineBreaks(para.type.create({ lineBreaks: change!.value }, para.content)));
    assert.equal(liveLineBreaks(para.type.create({ lineBreaks: change!.value }, schema.text("One two three four five six seven eight nine ten!"))), null);
  });
});

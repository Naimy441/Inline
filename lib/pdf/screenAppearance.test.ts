import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pageForAppearance, screenshotPage } from "@/lib/pdf/screenAppearance";
import type { PdfPage } from "@/lib/pdf/pdfWriter";

const page: PdfPage = {
  width: 612,
  height: 792,
  items: [
    { kind: "text", x: 72, y: 80, text: "Hello", font: "Helvetica", size: 12, color: [0, 0, 0] },
    { kind: "text", x: 72, y: 100, text: "Red", font: "Helvetica", size: 12, color: [0.8, 0.1, 0.1] },
    { kind: "line", x1: 72, y1: 110, x2: 200, y2: 110, width: 1, color: [0, 0, 0] },
    { kind: "rect", x: 72, y: 120, width: 40, height: 12, fill: [1, 1, 0] },
    { kind: "rect", x: 72, y: 140, width: 10, height: 10, fill: [0, 0, 0] },
    { kind: "image", x: 72, y: 160, width: 40, height: 16, jpeg: new Uint8Array([1, 2, 3]), pixelWidth: 2, pixelHeight: 1, ink: true },
  ],
};

describe("screenshot appearance", () => {
  it("leaves a light page as the print model drew it", () => {
    assert.equal(pageForAppearance(page, "light"), page);
    assert.equal(screenshotPage(page, "light").ink.length, 0);
    assert.equal(screenshotPage(page, "light").page, page);
  });

  it("paints default ink for a dark page and keeps other colors", () => {
    const dark = pageForAppearance(page, "dark");
    const text = dark.items[0];
    const red = dark.items[1];
    const line = dark.items[2];
    const yellow = dark.items[3];
    const box = dark.items[4];
    assert.equal(text?.kind, "text");
    assert.equal(red?.kind, "text");
    assert.equal(line?.kind, "line");
    assert.equal(yellow?.kind, "rect");
    assert.equal(box?.kind, "rect");
    if (text?.kind !== "text" || red?.kind !== "text" || line?.kind !== "line" || yellow?.kind !== "rect" || box?.kind !== "rect") return;
    assert.ok(text.color[0]! > 0.85 && text.color[1]! > 0.85);
    assert.deepEqual(red.color, [0.8, 0.1, 0.1]);
    assert.ok(line.color[0]! > 0.85);
    assert.deepEqual(yellow.fill, [1, 1, 0]);
    assert.ok(box.fill[0]! > 0.85);
    assert.equal(page.items[0] && page.items[0].kind === "text" ? page.items[0].color[0] : 1, 0);
  });

  it("holds equation pictures out of a dark page so they can be composited", () => {
    const shot = screenshotPage(page, "dark");
    assert.equal(shot.ink.length, 1);
    assert.equal(shot.ink[0]?.ink, true);
    assert.equal(shot.page.items.some((item) => item.kind === "image"), false);
  });
});

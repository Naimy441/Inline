import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { markdownToDoc } from "@/lib/doc/markdown";
import { buildPdf } from "@/lib/pdf/pdfWriter";
import {
  canvasToMarkdown,
  normalizeCanvasHtml,
  pageToCanvasHtml,
  parseCanvas,
  replaceCanvas,
  sanitizeLayoutHtml,
  setRegionMode,
  setRegionText,
  setSectionOpen,
  starterCanvasHtml,
} from "@/lib/doc/canvas";
import { canvasPdfModel } from "@/lib/doc/canvasPdf";

describe("canvas documents", () => {
  test("a new canvas has an editable passage, a layout, and a notebook cell", () => {
    const html = normalizeCanvasHtml(starterCanvasHtml());
    const model = parseCanvas(html);
    assert.equal(model.sections.length, 1);
    assert.equal(model.sections[0]!.open, true);
    assert.equal(model.sections[0]!.title, "Untitled canvas");
    const text = model.sections[0]!.blocks.find((block) => block.kind === "text");
    const layout = model.sections[0]!.blocks.find((block) => block.kind === "layout");
    const cell = model.sections[0]!.blocks.find((block) => block.kind === "cell");
    assert.equal(text && text.kind === "text" ? text.text : "", "Start writing here. This text stays editable.");
    assert.equal(text?.mode, "text");
    assert.equal(layout?.mode, "structure");
    assert.equal(cell && cell.kind === "cell" ? cell.language : "", "javascript");
    assert.match(cell && cell.kind === "cell" ? cell.source : "", /hello from the canvas/);
  });

  test("editing text keeps the surrounding structure", () => {
    const next = setRegionText(starterCanvasHtml(), "intro-text", "The quarter closed ahead of plan.");
    const model = parseCanvas(next);
    const text = model.sections[0]!.blocks.find((block) => block.id === "intro-text");
    assert.equal(text && text.kind === "text" ? text.text : "", "The quarter closed ahead of plan.");
    assert.match(next, /data-canvas-layout/);
    assert.match(next, /intro-cell/);
  });

  test("a region can be switched to code and a section can close", () => {
    const coded = setRegionMode(starterCanvasHtml(), "intro-layout", "code");
    const closed = setSectionOpen(coded, "intro", false);
    const model = parseCanvas(closed);
    const layout = model.sections[0]!.blocks.find((block) => block.id === "intro-layout");
    assert.equal(layout?.mode, "code");
    assert.equal(model.sections[0]!.open, false);
    assert.equal(parseCanvas(setSectionOpen(closed, "intro", true)).sections[0]!.open, true);
  });

  test("the agent replaces one section's text", () => {
    const next = replaceCanvas(starterCanvasHtml(), "Start writing here. This text stays editable.", "Revenue grew.");
    assert.match(parseCanvas(next).sections[0]!.blocks.map((block) => (block.kind === "text" ? block.text : "")).join(" "), /Revenue grew/);
    assert.throws(() => replaceCanvas(next, "Revenue grew.", "Revenue grew."), /exactly the same/);
    assert.throws(() => replaceCanvas(starterCanvasHtml(), "missing", "x"), /not found/);
  });

  test("a page becomes a canvas and a canvas becomes a page", () => {
    const page = markdownToDoc("# Notes\n\nThe meeting is on Tuesday.\n\n```javascript\nconsole.log(1)\n```");
    const html = pageToCanvasHtml(page);
    const model = parseCanvas(html);
    assert.match(model.sections.map((section) => section.title).join(" "), /Notes/);
    assert.match(canvasToMarkdown(html), /The meeting is on Tuesday/);
    assert.match(canvasToMarkdown(html), /console\.log\(1\)/);
    const back = markdownToDoc(canvasToMarkdown(html));
    assert.match(back.textContent, /Tuesday/);
    assert.match(back.textContent, /console\.log\(1\)/);
  });

  test("a page picture becomes layout the canvas can show", () => {
    const html = pageToCanvasHtml(markdownToDoc("![A cat](https://example.com/cat.png)"));
    assert.match(html, /https:\/\/example\.com\/cat\.png/);
    assert.match(html, /data-canvas-layout/);
    const clean = sanitizeLayoutHtml(`<img src="https://example.com/cat.png" alt="A cat"><img src="javascript:alert(1)">`);
    assert.match(clean, /cat\.png/);
    assert.doesNotMatch(clean, /javascript/);
  });

  test("layout html cannot carry a script", () => {
    const clean = sanitizeLayoutHtml(`<div class="figure"><b>12</b></div><script>alert(1)</script><img src=x onerror="alert(1)"><a href="javascript:alert(1)">no</a>`);
    assert.match(clean, /12/);
    assert.doesNotMatch(clean, /script|onerror|javascript/i);
  });

  test("a canvas exports to a PDF that contains its text", () => {
    const html = setRegionText(starterCanvasHtml(), "intro-text", "The quarter closed ahead of plan.");
    const bytes = Buffer.from(buildPdf(canvasPdfModel(html, "Quarter canvas", { "intro-cell": { stdout: "hello from the canvas\n", stderr: "", error: null, ranAt: 1 } })));
    const pdf = bytes.toString("latin1");
    assert.match(pdf, /^%PDF/);
    assert.match(pdf, /ahead of plan/);
    assert.match(pdf, /hello from the canvas/);
    assert.match(pdf, /Quarter canvas/);
  });
});

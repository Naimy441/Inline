import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { parseColor, snapshotPages, standardFont, type Box, type PageMeasurer, type SnapshotStyle } from "./pageSnapshot";
import type { PdfItem, PdfText } from "./pdfWriter";

// A fake layout: every measured element carries data-box="left top width height"
// in viewport pixels, text advances 5px per character, and data-wrap="n" moves
// characters from index n onto the next line. The page is shown at 50% zoom.
const ZOOM = 0.5;
const CHAR = 5;

const INHERITED = ["color", "font-family", "font-size", "font-weight", "font-style", "text-transform", "list-style-type", "visibility", "line-height"];
const DEFAULTS: Record<string, string> = {
  display: "block",
  visibility: "visible",
  color: "rgb(0, 0, 0)",
  "background-color": "rgba(0, 0, 0, 0)",
  "font-family": "Arial, sans-serif",
  "font-size": "14.6667px",
  "font-weight": "400",
  "font-style": "normal",
  "text-decoration-line": "none",
  "text-transform": "none",
  "list-style-type": "",
  "line-height": "normal",
};

function readBox(el: Element | null): Box {
  const value = el?.closest("[data-box]")?.getAttribute("data-box");
  if (!value) return { left: 0, top: 0, width: 0, height: 0 };
  const [left, top, width, height] = value.split(" ").map(Number);
  return { left, top, width, height };
}

function fakeMeasurer(): PageMeasurer {
  const style = (el: Element): SnapshotStyle => {
    const read = (name: string) => {
      for (let node: Element | null = el; node; node = INHERITED.includes(name) ? node.parentElement : null) {
        const value = (node as HTMLElement).style?.getPropertyValue(name);
        if (value) return value;
      }
      return DEFAULTS[name] ?? "";
    };
    const sides = ["top", "right", "bottom", "left"] as const;
    const border = Object.fromEntries(
      sides.flatMap((side) => {
        const key = side[0].toUpperCase() + side.slice(1);
        return [
          [`border${key}Width`, read(`border-${side}-width`) || "0px"],
          [`border${key}Style`, read(`border-${side}-style`) || "none"],
          [`border${key}Color`, read(`border-${side}-color`) || "rgb(0, 0, 0)"],
        ];
      }),
    );
    return {
      display: read("display"),
      visibility: read("visibility"),
      color: read("color"),
      backgroundColor: read("background-color"),
      fontFamily: read("font-family"),
      fontSize: read("font-size"),
      fontWeight: read("font-weight"),
      fontStyle: read("font-style"),
      textDecorationLine: read("text-decoration-line"),
      textTransform: read("text-transform"),
      listStyleType: read("list-style-type"),
      lineHeight: read("line-height"),
      ...border,
      getPropertyValue: read,
    } as SnapshotStyle;
  };
  return {
    box: (el) => readBox(el),
    boxes: (el) => [readBox(el)],
    textBoxes: (node, start, end) => {
      const box = readBox(node.parentElement);
      const wrap = Number(node.parentElement?.closest("[data-wrap]")?.getAttribute("data-wrap") ?? Infinity);
      const piece = (from: number, to: number) => {
        const line = from >= wrap ? 1 : 0;
        const column = line ? from - wrap : from;
        return { left: box.left + column * CHAR, top: box.top + line * box.height, width: (to - from) * CHAR, height: box.height };
      };
      return start < wrap && end > wrap ? [piece(start, wrap), piece(wrap, end)] : [piece(start, end)];
    },
    layoutSize: (el) => {
      const box = readBox(el);
      return { width: box.width / ZOOM, height: box.height / ZOOM };
    },
    style,
    textWidth: (text) => text.length * CHAR,
    image: () => ({ jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 4, height: 2 }),
  };
}

// Two Letter pages (816 x 1056 CSS px) at 50% zoom, 12px apart, starting at (100, 50),
// laid out the way components/workspace/PageCanvas.tsx renders them.
const FIXTURE = `
<div class="page-stack">
  <div class="sheet" data-box="100 50 408 528">
    <div class="sheet-header" data-box="100 50 408 48"><span data-box="148 62 300 10">Header text</span></div>
    <div class="sheet-footer" data-box="100 530 408 48"><span class="sheet-number" data-box="450 556 6 8">1</span></div>
  </div>
  <div class="sheet" data-box="100 590 408 528">
    <div class="sheet-header" data-box="100 590 408 48"></div>
    <div class="sheet-footer" data-box="100 1070 408 48"></div>
  </div>
  <div class="page-content" data-box="148 98 312 1000">
    <div class="doc-content ProseMirror" style="color: rgb(232, 234, 237)" data-box="148 98 312 1000">
      <p id="hello" data-box="148 98 300 8">Hello world</p>
      <p data-box="148 110 300 8"><mark style="background-color: #ffff00" data-box="148 110 40 8">marked</mark></p>
      <p data-box="148 122 300 8"><span class="comment-hl" style="background-color: #fef7c0" data-box="148 122 40 8">noted</span><span class="review-delete" data-box="200 122 20 8">gone</span><span class="review-controls" data-box="220 122 30 8"><button>Keep</button></span></p>
      <div class="page-break" data-page-break="true" data-box="148 134 300 11"></div>
      <p data-box="148 146 300 8"><u style="text-decoration-line: underline" data-box="148 146 25 8">under</u> <a href="https://example.com" style="text-decoration-line: underline; color: #0b57d0" data-box="180 146 20 8">link</a></p>
      <ol start="3" data-box="160 158 288 20">
        <li data-box="160 158 288 8">third</li>
        <li data-box="160 168 288 8">fourth</li>
      </ol>
      <ul data-box="160 180 288 18">
        <li class="task-item" data-checked="true" data-box="160 180 288 8">done</li>
        <li class="task-item" data-checked="false" data-box="160 190 288 8">todo</li>
      </ul>
      <p data-wrap="4" data-box="148 202 20 8">abcdefgh</p>
      <p data-box="148 212 300 8"><span style="font-family: Georgia, serif; font-weight: 700" data-box="148 212 40 8">Serif</span><span style="display: none">hidden</span><span class="np-mark np-para" data-box="190 212 4 8">¶</span></p>
      <table data-box="148 224 300 20"><tbody><tr><td style="border-top-width: 1px; border-top-style: solid; border-top-color: #dadce0" data-box="148 224 150 20">cell</td></tr></tbody></table>
      <div class="doc-image" data-box="148 250 100 50"><img src="x.png" data-box="148 250 100 50"></div>
      <div class="page-gap" data-box="148 300 300 340"><span>spacer</span></div>
      <p data-box="148 638 300 8"><span class="review-insert" style="background-color: rgba(46, 160, 67, 0.16)" data-box="148 638 60 8">Second page</span></p>
    </div>
  </div>
</div>`;

function snapshot() {
  const dom = new JSDOM(FIXTURE);
  const root = dom.window.document.querySelector<HTMLElement>(".page-stack")!;
  return snapshotPages(root, "Report", fakeMeasurer());
}

const texts = (items: PdfItem[]) => items.filter((item): item is PdfText => item.kind === "text");
const find = (items: PdfItem[], text: string) => texts(items).find((item) => item.text === text);

describe("snapshotPages", () => {
  it("creates one page per sheet in points at the sheet's unzoomed size", () => {
    const model = snapshot();
    assert.equal(model.title, "Report");
    assert.equal(model.pages.length, 2);
    for (const page of model.pages) {
      assert.equal(page.width, 612);
      assert.equal(page.height, 792);
    }
  });

  it("places each word where the zoomed layout put it", () => {
    const [first] = snapshot().pages;
    const hello = find(first.items, "Hello")!;
    const world = find(first.items, "World") ?? find(first.items, "world")!;
    // (148 - 100) px at 50% zoom is 96 CSS px, or one inch.
    assert.equal(hello.x, 72);
    assert.equal(world.x, 72 + (6 * CHAR / ZOOM) * 0.75);
    // Baseline sits inside the 12pt line box that starts one inch down.
    assert.ok(hello.y > 72 && hello.y < 84);
    assert.equal(hello.font, "Helvetica");
    assert.equal(Math.round(hello.size), 11);
  });

  it("puts content on the page its layout box falls on", () => {
    const [first, second] = snapshot().pages;
    assert.ok(find(second.items, "Second"));
    assert.equal(find(first.items, "Second"), undefined);
    const second0 = find(second.items, "Second")!;
    assert.equal(second0.x, 72);
    assert.ok(second0.y > 72 && second0.y < 84);
  });

  it("prints theme ink as black and keeps explicit colors", () => {
    const [first] = snapshot().pages;
    assert.deepEqual(find(first.items, "Hello")!.color, [0, 0, 0]);
    const link = find(first.items, "link")!;
    assert.deepEqual(link.color.map((c) => Math.round(c * 255)), [11, 87, 208]);
  });

  it("leaves out editor UI, pending deletions, review tints and hidden nodes", () => {
    const all = snapshot().pages.flatMap((page) => texts(page.items).map((item) => item.text));
    for (const absent of ["gone", "Keep", "spacer", "¶", "hidden"]) assert.ok(!all.includes(absent), absent);
    assert.ok(all.includes("noted"));
    const fills = snapshot().pages.flatMap((page) => page.items).filter((item) => item.kind === "rect").map((item) => item.kind === "rect" && item.fill);
    // The highlight and the checked checklist box; no comment, review or paper tints.
    assert.equal(fills.length, 2);
    assert.deepEqual(fills[0], [1, 1, 0]);
  });

  it("draws underlines, link targets, table borders and images", () => {
    const items = snapshot().pages[0].items;
    const under = find(items, "under")!;
    const lines = items.filter((item) => item.kind === "line");
    assert.ok(lines.some((line) => line.kind === "line" && line.x1 === under.x && line.y1 > under.y));
    const link = items.find((item) => item.kind === "link");
    assert.equal(link?.kind === "link" && link.uri, "https://example.com");
    const border = lines.find((line) => line.kind === "line" && line.y1 === line.y2 && Math.abs(line.width - 0.75) < 1e-9);
    assert.ok(border, "td top border");
    const image = items.find((item) => item.kind === "image");
    assert.ok(image && image.kind === "image");
    assert.equal(image.width, (100 / ZOOM) * 0.75);
    assert.equal(image.pixelWidth, 4);
  });

  it("adds list markers right-aligned before the item, honoring start", () => {
    const items = snapshot().pages[0].items;
    const third = find(items, "third")!;
    const marker = find(items, "3.")!;
    assert.ok(marker, "ordered marker");
    assert.equal(marker.y, third.y);
    // Marker text is two characters wide and ends before the item's text.
    assert.ok(marker.x + 2 * CHAR * 0.75 < third.x);
    assert.ok(find(items, "4."));
  });

  it("draws checklist boxes, filled when checked, instead of a bullet", () => {
    const items = snapshot().pages[0].items;
    const done = find(items, "done")!;
    assert.ok(done && find(items, "todo"));
    assert.equal(find(items, "\u2022"), undefined, "no bullet for task items");
    const fills = items.filter((item) => item.kind === "rect");
    assert.ok(fills.some((rect) => rect.kind === "rect" && rect.x < done.x && Math.abs(rect.y - (done.y - 8)) < 8), "checked box is filled");
    const boxEdges = items.filter((item) => item.kind === "line" && item.x2 < done.x);
    assert.ok(boxEdges.length >= 8, "both boxes are outlined");
  });

  it("splits a word that wraps across lines", () => {
    const items = snapshot().pages[0].items;
    const head = find(items, "abcd")!;
    const tail = find(items, "efgh")!;
    assert.ok(head && tail);
    assert.equal(head.x, tail.x);
    assert.ok(tail.y > head.y);
  });

  it("maps fonts to the standard PDF families", () => {
    assert.equal(find(snapshot().pages[0].items, "Serif")!.font, "Times-Bold");
    assert.equal(standardFont({ fontFamily: "\"Courier New\", monospace", fontWeight: "400", fontStyle: "italic" }), "Courier-Oblique");
    assert.equal(standardFont({ fontFamily: "Roboto", fontWeight: "700", fontStyle: "italic" }), "Helvetica-BoldOblique");
  });

  it("renders headers, footers and page numbers from the sheets", () => {
    const items = snapshot().pages[0].items;
    assert.ok(find(items, "Header") && find(items, "text"));
    assert.ok(find(items, "1"));
  });
});

describe("parseColor", () => {
  it("reads the color forms getComputedStyle returns", () => {
    assert.deepEqual(parseColor("rgb(255, 0, 0)"), { rgb: [1, 0, 0], alpha: 1 });
    assert.deepEqual(parseColor("rgba(0, 0, 0, 0)"), { rgb: [0, 0, 0], alpha: 0 });
    assert.deepEqual(parseColor("color(srgb 1 0.5 0 / 0.5)"), { rgb: [1, 0.5, 0], alpha: 0.5 });
    assert.deepEqual(parseColor("#ff0"), { rgb: [1, 1, 0], alpha: 1 });
    assert.equal(parseColor("oklab(0.5 0 0)"), null);
  });
});

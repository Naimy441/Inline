import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { DOMParser as PMDOMParser } from "prosemirror-model";

import { schema } from "@/lib/doc/schema";
import { pictureHtml } from "@/lib/editor/imageClipboard";
import { transformPastedHtml } from "@/lib/editor/paste";

const { window } = new JSDOM("");
const ORIGIN = "http://localhost:3000";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

/** Parse pasted HTML as the editor does, on a page at `origin`. */
function paste(html: string, origin: string) {
  const previous = globalThis.DOMParser;
  globalThis.DOMParser = window.DOMParser;
  try {
    const container = window.document.createElement("div");
    container.innerHTML = transformPastedHtml(html, origin).html;
    return PMDOMParser.fromSchema(schema).parseSlice(container).content.firstChild!;
  } finally {
    globalThis.DOMParser = previous;
  }
}

describe("copying a picture", () => {
  const image = schema.node("image", { src: "/api/uploads/abc.png", alt: "Screenshot", width: "320px", align: "center" });

  it("carries the picture itself, so other apps can paste it", () => {
    const html = pictureHtml(image, window.document, ORIGIN, PNG);
    const img = new JSDOM(html).window.document.querySelector("img")!;
    assert.equal(img.getAttribute("src"), PNG);
    assert.equal(img.getAttribute("alt"), "Screenshot");
    assert.equal(img.style.width, "320px");
    assert.equal(img.getAttribute("data-inline-src"), `${ORIGIN}/api/uploads/abc.png`);
  });

  it("falls back to the picture's full address when it can't be drawn", () => {
    const html = pictureHtml(image, window.document, ORIGIN, null);
    assert.equal(new JSDOM(html).window.document.querySelector("img")!.getAttribute("src"), `${ORIGIN}/api/uploads/abc.png`);
  });

  it("pastes back into Inline as the stored file, at its size", () => {
    const pasted = paste(pictureHtml(image, window.document, ORIGIN, PNG), ORIGIN);
    assert.equal(pasted.type.name, "image");
    assert.equal(pasted.attrs.src, "/api/uploads/abc.png");
    assert.equal(pasted.attrs.width, "320px");
  });

  it("pastes into another Inline as the picture itself, which that Inline uploads", () => {
    assert.equal(paste(pictureHtml(image, window.document, ORIGIN, PNG), "http://localhost:4000").attrs.src, PNG);
  });

  it("copies a picture in a line of text as one", () => {
    const icon = schema.node("inline_image", { src: "/api/uploads/icon.png", width: 16, height: 16 });
    const pasted = paste(`<p>${pictureHtml(icon, window.document, ORIGIN, PNG)}</p>`, ORIGIN);
    assert.equal(pasted.firstChild!.type.name, "inline_image");
    assert.equal(pasted.firstChild!.attrs.src, "/api/uploads/icon.png");
    assert.equal(pasted.firstChild!.attrs.width, 16);
  });
});

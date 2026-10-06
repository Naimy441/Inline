import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { dataUrlToBlob, resizedWidth } from "@/lib/editor/imageView";

describe("image resizing", () => {
  it("follows the drag, mirrored for the left handle", () => {
    assert.equal(resizedWidth(300, 50, 800), 350);
    assert.equal(resizedWidth(300, 50, 800, "left"), 250);
    assert.equal(resizedWidth(300, -40.4, 800), 260);
  });

  it("stays between a minimum and the page width", () => {
    assert.equal(resizedWidth(300, -1000, 800), 48);
    assert.equal(resizedWidth(300, 1000, 800), 800);
  });
});

describe("pasted data: URLs", () => {
  it("decodes base64 images with their type", async () => {
    const blob = dataUrlToBlob("data:image/png;base64,iVBORw0KGgo=");
    assert.ok(blob);
    assert.equal(blob.type, "image/png");
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(dataUrlToBlob("data:image/svg+xml;charset=utf-8;base64,PHN2Zy8+")?.type, "image/svg+xml");
  });

  it("ignores URLs it can't decode", () => {
    assert.equal(dataUrlToBlob("data:image/png,rawtext"), null);
    assert.equal(dataUrlToBlob("https://example.com/a.png"), null);
  });
});

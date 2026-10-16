import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { croppedFrame, cropToSrcRect, cssPx, parseCropToken, pictureCrop, pictureRotate, pictureWidth, rotateFromWord, rotateToWord, srcRectToCrop } from "./picture";

describe("picture crop and rotation", () => {
  it("reads a crop as the percent hidden on each edge", () => {
    assert.deepEqual(parseCropToken("25,10,0,5"), { l: 0.25, t: 0.1, r: 0, b: 0.05 });
    assert.equal(parseCropToken("0,0,0,0"), null);
    assert.equal(parseCropToken("80,0,80,0"), null, "a crop has to leave some of the picture");
    assert.equal(pictureCrop({ l: 0.25, t: 0, r: 0, b: 0 })?.l, 0.25);
  });

  it("sizes the visible window and shifts the source out of it", () => {
    const box = croppedFrame(200, 400, 200, { l: 0.5, t: 0, r: 0, b: 0 });
    assert.equal(box.frameWidth, 200);
    assert.equal(box.frameHeight, 200);
    assert.equal(box.imageWidth, 400);
    assert.equal(box.offsetX, -200);
    assert.ok(box.imageWidth > box.frameWidth);
  });

  it("stores a bare pixel width with a unit and keeps percents", () => {
    assert.equal(pictureWidth("480"), "480px");
    assert.equal(pictureWidth("480px"), "480px");
    assert.equal(pictureWidth("70%"), "70%");
    assert.equal(pictureWidth(""), null);
  });

  it("fits a pixel width to the text column", () => {
    assert.equal(cssPx("2000px", 600, 4000), 600);
    assert.equal(cssPx("480", 600, 4000), 480);
    assert.equal(cssPx("70%", 600, 4000), 420);
    assert.equal(cssPx(null, 600, 4000), 600);
  });

  it("speaks Word's units", () => {
    const crop = { l: 0.1, t: 0.2, r: 0, b: 0 };
    assert.deepEqual(cropToSrcRect(crop), { l: 10000, t: 20000, r: 0, b: 0 });
    assert.deepEqual(srcRectToCrop({ l: "10000", t: "20000", r: "0", b: "0" }), crop);
    assert.equal(rotateToWord(90), 5_400_000);
    assert.equal(rotateFromWord(5_400_000), 90);
    assert.equal(pictureRotate(0), null);
    assert.equal(pictureRotate(270), -90);
  });
});

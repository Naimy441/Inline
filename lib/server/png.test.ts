import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cropBitmap, decodePng, encodePng, inkBounds, shrinkBitmap, type Bitmap } from "./png";

function gradient(width: number, height: number, alpha = 255): Bitmap {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) data.set([x * 7, y * 5, (x + y) * 3, alpha], (y * width + x) * 4);
  return { width, height, data };
}

describe("png", () => {
  it("writes PNGs it reads back exactly, opaque and transparent", () => {
    for (const bitmap of [gradient(13, 9), gradient(5, 4, 120)]) {
      const back = decodePng(encodePng(bitmap));
      assert.equal(back.width, bitmap.width);
      assert.equal(back.height, bitmap.height);
      assert.deepEqual(back.data, bitmap.data);
    }
  });

  it("crops, clamping to the picture", () => {
    const bitmap = gradient(10, 10);
    const crop = cropBitmap(bitmap, 8, 2, 5, 3);
    assert.equal(crop.width, 2);
    assert.equal(crop.height, 3);
    assert.deepEqual([...crop.data.subarray(0, 4)], [56, 10, 30, 255]);
  });

  it("scales down by averaging and finds where the ink is", () => {
    const white = { width: 4, height: 4, data: new Uint8Array(64).fill(255) };
    white.data.set([0, 0, 0, 255], (1 * 4 + 2) * 4);
    assert.deepEqual(inkBounds(white), { x: 2, y: 1, width: 1, height: 1 });
    const half = shrinkBitmap(white, 2, 2);
    assert.deepEqual([...half.data.subarray(4, 8)], [191, 191, 191, 255]);
    assert.equal(inkBounds({ width: 2, height: 2, data: new Uint8Array(16).fill(255) }), null);
  });
});

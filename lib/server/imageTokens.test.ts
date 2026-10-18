import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { encodePng } from "./png";
import { imagePreview } from "./imagePreview";
import { resizedSize } from "./imageTokens";

describe("image token cap", () => {
  test("matches Anthropic's published resize examples", () => {
    assert.deepEqual(resizedSize(1075, 1520), [924, 1307]);
    assert.deepEqual(resizedSize(1920, 1080), [1456, 819]);
    assert.deepEqual(resizedSize(1092, 1092), [1092, 1092]);
    assert.deepEqual(resizedSize(4, 4), [4, 4]);
    const [wide, tall] = resizedSize(2000, 1500);
    assert.ok(wide < 2000 && tall < 1500);
    assert.ok(Math.ceil(wide / 28) * Math.ceil(tall / 28) <= 1568);
  });

  test("a large PNG is a downscaled preview and a small one is unchanged", () => {
    const wide = new Uint8Array(1920 * 1080 * 4).fill(255);
    const png = encodePng({ width: 1920, height: 1080, data: wide });
    const preview = imagePreview("plots/butterfly.png", png, "image/png");
    assert.equal(preview.image, true);
    assert.equal(preview.mime, "image/png");
    assert.match(preview.text, /1920×1080 to 1456×819/);
    assert.match(preview.text, /screenshot_page/);
    assert.ok(preview.data.byteLength < png.byteLength);

    const tiny = encodePng({ width: 4, height: 4, data: new Uint8Array(64).fill(255) });
    const same = imagePreview("chart.png", tiny, "image/png");
    assert.equal(same.image, true);
    assert.equal(same.data, tiny);
    assert.match(same.text, /^chart\.png \(image\/png, \d+ bytes\)\.$/);
  });

  test("an oversized image that cannot be scaled is left out of the transcript", () => {
    const jpeg = new Uint8Array(32);
    jpeg[0] = 0xff;
    jpeg[1] = 0xd8;
    jpeg[2] = 0xff;
    jpeg[3] = 0xc0;
    jpeg[7] = 0x07;
    jpeg[8] = 0xd0; // height 2000
    jpeg[9] = 0x05;
    jpeg[10] = 0xdc; // width 1500
    const preview = imagePreview("photo.jpg", jpeg, "image/jpeg");
    assert.equal(preview.image, false);
    assert.match(preview.text, /1500×2000/);
    assert.match(preview.text, /was not added to the transcript/);
  });
});

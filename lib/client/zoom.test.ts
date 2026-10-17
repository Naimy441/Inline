import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anchorAt, clampAboveLock, clampZoom, commentFitReserve, fitScale, FIT_MARGIN, pinchBox, pinchTransform, placeOnAxis, scrollForAnchor, stepPinch, touchDistance, touchMidpoint, zoomFromPinch, zoomFromWheel, type PinchFrame } from "./zoom";

describe("document zoom", () => {
  it("stays inside the same range as the zoom menu", () => {
    assert.equal(clampZoom(1), 1);
    assert.equal(clampZoom(3), 2);
    assert.equal(clampZoom(0.1), 0.5);
    assert.equal(clampZoom(Number.NaN), 1);
  });

  it("zooms in when the wheel delta is negative and out when it is positive", () => {
    const zoomIn = zoomFromWheel(1, -80, 0);
    const zoomOut = zoomFromWheel(1, 80, 0);
    assert.ok(zoomIn > 1.3 && zoomIn < 1.7, `zoom in ${zoomIn}`);
    assert.ok(zoomOut < 0.75 && zoomOut > 0.55, `zoom out ${zoomOut}`);
    // Extreme wheels hit the absolute ends. The toolbar lock raises the floor later.
    assert.equal(zoomFromWheel(1, 10_000, 0), 0.05);
    assert.equal(zoomFromWheel(1, -10_000, 0), 2);
    // A line-mode notch is a real step, not a fraction of a percent.
    assert.ok(zoomFromWheel(1, 3, 1) < 0.75);
  });

  it("a full pinch covers most of the 50%–200% range", () => {
    assert.equal(zoomFromWheel(1, -150, 0), 2);
    assert.equal(zoomFromWheel(1, 150, 0), 0.5);
    // Fingers a fifth farther apart, or a fifth closer.
    assert.equal(zoomFromPinch(1, 100, 120), 2);
    assert.equal(zoomFromPinch(1, 120, 100), 0.5);
    // A smaller spread is already a clear zoom, and it has not hit the cap yet.
    const partial = zoomFromPinch(1, 100, 110);
    assert.ok(partial > 1.3 && partial < 1.7, `partial ${partial}`);
  });

  it("follows the ratio of two finger distances", () => {
    assert.ok(zoomFromPinch(1, 100, 150) > zoomFromPinch(1, 100, 110));
    assert.equal(zoomFromPinch(1, 100, 20), 0.05);
    assert.equal(zoomFromPinch(1.25, 0, 40), 1.25);
  });

  it("keeps the anchored point on the same client pixel after the frame grows", () => {
    const before = { left: 192, top: 28, width: 816, height: 1056 };
    const anchor = anchorAt(before, 600, 28);
    assert.ok(Math.abs(anchor.fx - 0.5) < 0.001);
    const after = { left: 40, top: 28, width: 1632, height: 2112 };
    const next = scrollForAnchor({ scrollLeft: 0, scrollTop: 0 }, after, anchor);
    const screenX = after.left - next.scrollLeft + anchor.fx * after.width;
    const screenY = after.top - next.scrollTop + anchor.fy * after.height;
    assert.ok(Math.abs(screenX - 600) < 0.01);
    assert.ok(Math.abs(screenY - 28) < 0.01);
    assert.ok(next.scrollLeft > 0, "centering a wider page scrolls sideways");
  });

  it("stops a pinch at the lock and still caps it at 200%", () => {
    assert.equal(clampAboveLock(0.4, 1), 1);
    assert.equal(clampAboveLock(1.5, 1), 1.5);
    assert.equal(clampAboveLock(3, 1), 2);
    assert.equal(clampAboveLock(0.2, 0.36), 0.36);
  });

  it("fits the page with half an inch of background on each side", () => {
    assert.equal(FIT_MARGIN, 48);
    const wide = fitScale(1000, 816);
    assert.ok(Math.abs(816 * wide - (1000 - 96)) < 1, `wide page ${816 * wide}`);
    assert.ok(wide > 1, "a wide window grows past 100%");
    const narrow = fitScale(700, 816);
    assert.ok(narrow < 1);
    assert.ok(Math.abs(816 * narrow - (700 - 96)) < 1, `narrow page ${816 * narrow}`);
    assert.equal(fitScale(4000, 816), 2);
  });

  it("reserves a comment column when Fit would otherwise fill the canvas", () => {
    const canvas = 1200;
    const page = 816;
    assert.equal(commentFitReserve(canvas, page), 296);
    const visual = fitScale(canvas - 296, page) * page;
    assert.ok(canvas - visual >= 376, `spare ${canvas - visual}`);
    // The page plus the comment padding still fits, so the cards keep the right side.
    const placed = placeOnAxis({ canvas, page: visual, padStart: 40, padEnd: 40 + 296, pageStart: 0, center: true });
    assert.equal(placed.scroll, 0);
    assert.equal(placed.padEnd, 40 + 296);
    assert.equal(commentFitReserve(400, page), 0);
  });

  it("centers on the lock and keeps a zoomed-in page where the pointer put it", () => {
    // The page fits: the pointer spot is ignored and the gutters stay put, so margin can center it.
    assert.deepEqual(placeOnAxis({ canvas: 1440, page: 816, padStart: 40, padEnd: 40, pageStart: 108, center: true }), {
      padStart: 40,
      padEnd: 40,
      scroll: 0,
    });
    // The page itself fits, but the usual gutters would push a side off. Shrink them and stay centered.
    const snug = placeOnAxis({ canvas: 1440, page: 1400, padStart: 40, padEnd: 40, pageStart: 0, center: true });
    assert.ok(Math.abs(snug.padStart - 20) < 0.01 && Math.abs(snug.padEnd - 20) < 0.01);
    assert.equal(snug.scroll, 0);

    // Past the lock. The pointer wants the page further right than the gutter allows.
    // Growing that side keeps the spot, and scrolling still reaches both edges and the background.
    const wide = placeOnAxis({ canvas: 1440, page: 1632, padStart: 40, padEnd: 40, pageStart: 108, center: false });
    assert.equal(wide.padStart, 108);
    assert.equal(wide.padEnd, 40);
    assert.equal(wide.scroll, 0);
    const content = wide.padStart + 1632 + wide.padEnd;
    const max = content - 1440;
    assert.ok(Math.abs(wide.padStart - wide.scroll - 108) < 0.01, "the pointer spot is where it was");
    assert.ok(wide.padStart - 40 >= 0 && wide.padStart - 40 <= max + 0.01, "the left background can scroll into view");
    assert.equal(wide.padEnd, 40, "the right background stays in the scroll range");

    // Landing on the lock centers a wider page. The gutters stay, so both backgrounds remain.
    const centered = (1440 - 1632) / 2;
    const toolbar = placeOnAxis({ canvas: 1440, page: 1632, padStart: 40, padEnd: 40, pageStart: 0, center: true });
    assert.equal(toolbar.padStart, 40);
    assert.equal(toolbar.padEnd, 40);
    assert.ok(Math.abs(toolbar.padStart - toolbar.scroll - centered) < 0.01);

    // Back on the lock, a page that fits returns to the centered layout.
    assert.deepEqual(placeOnAxis({ canvas: 1440, page: 816, padStart: 40, padEnd: 40, pageStart: 200, center: true }), {
      padStart: 40,
      padEnd: 40,
      scroll: 0,
    });

    // Past the lock, a page that still fits does not snap back to center.
    const aside = placeOnAxis({ canvas: 1000, page: 800, padStart: 40, padEnd: 40, pageStart: 20, center: false });
    const visual = aside.padStart - aside.scroll;
    assert.ok(Math.abs(visual - 20) < 0.5, `stayed at ${visual}`);
    const centeredNarrow = (1000 - 800) / 2;
    assert.ok(Math.abs(visual - centeredNarrow) > 40);
  });

  it("keeps the finger point fixed across pinch steps without measuring layout", () => {
    const start: PinchFrame = { left: 100, top: 50, width: 800, height: 1000, tx: 0, ty: 0, scale: 1 };
    const origin = { x: 500, y: 250 };
    const zoomed = stepPinch(start, origin, 2);
    const box = pinchBox(zoomed);
    assert.equal(box.width, 1600);
    assert.ok(Math.abs(box.left + (400 / 800) * box.width - origin.x) < 1e-6);
    assert.ok(Math.abs(box.top + (200 / 1000) * box.height - origin.y) < 1e-6);
    assert.equal(pinchTransform(zoomed), `translate(${zoomed.tx}px, ${zoomed.ty}px) scale(2)`);

    const moved = { x: 520, y: 260 };
    const again = stepPinch(zoomed, moved, 2.2);
    const next = pinchBox(again);
    const localX = (moved.x - zoomed.left - zoomed.tx) / zoomed.scale;
    const localY = (moved.y - zoomed.top - zoomed.ty) / zoomed.scale;
    assert.ok(Math.abs(next.left + (localX / again.width) * next.width - moved.x) < 1e-6);
    assert.ok(Math.abs(next.top + (localY / again.height) * next.height - moved.y) < 1e-6);
    assert.equal(pinchTransform({ ...start, scale: 1 }), "");
  });

  it("reads a two-finger pinch from the midpoint and the spread", () => {
    const fingers = [
      { clientX: 100, clientY: 200 },
      { clientX: 160, clientY: 280 },
    ];
    assert.equal(touchDistance(fingers), 100);
    assert.deepEqual(touchMidpoint(fingers), { x: 130, y: 240 });
  });
});

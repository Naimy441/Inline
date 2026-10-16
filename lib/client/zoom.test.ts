import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anchorAt, clampZoom, horizontalPan, manualZoomOrigin, pinchBox, pinchTransform, scrollForAnchor, stepPinch, touchDistance, touchMidpoint, zoomFromPinch, zoomFromWheel, type PinchFrame } from "./zoom";

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
    assert.equal(zoomFromWheel(1, 10_000, 0), 0.5);
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
    assert.equal(zoomFromPinch(1, 100, 20), 0.5);
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

  it("centers a manual zoom only when both sides of the page fit", () => {
    // The page fits: the finger spot is ignored and the gutters stay put, so margin can center it.
    assert.deepEqual(horizontalPan({ canvasWidth: 1440, pageWidth: 816, padLeft: 40, padRight: 40, pageLeft: 108 }), {
      padLeft: 40,
      padRight: 40,
      scrollLeft: 0,
    });
    // The page itself fits, but the usual gutters would push a side off. Shrink them and stay centered.
    const snug = horizontalPan({ canvasWidth: 1440, pageWidth: 1400, padLeft: 40, padRight: 40, pageLeft: 0 });
    assert.ok(Math.abs(snug.padLeft - 20) < 0.01 && Math.abs(snug.padRight - 20) < 0.01);
    assert.equal(snug.scrollLeft, 0);

    // Wider than the view, and the finger wants the page further right than the gutter allows.
    // Growing the left side keeps that spot; scrolling still reaches both edges.
    const wide = horizontalPan({ canvasWidth: 1440, pageWidth: 1632, padLeft: 40, padRight: 40, pageLeft: 108 });
    assert.equal(wide.padLeft, 108);
    assert.equal(wide.padRight, 40);
    assert.equal(wide.scrollLeft, 0);
    const content = wide.padLeft + 1632 + wide.padRight;
    const max = content - 1440;
    assert.ok(Math.abs(wide.padLeft - wide.scrollLeft - 108) < 0.01, "the finger spot is where it was");
    assert.ok(wide.padLeft - 40 >= 0 && wide.padLeft - 40 <= max + 0.01, "the left edge can scroll up to the gutter");
    assert.ok(Math.abs(wide.padLeft - (1440 - 40 - 1632) - max) < 0.01, "the right edge is the far end of the scroll");

    // Toolbar zoom asks for the center. That spot is already in range, so the gutters stay.
    const centered = (1440 - 1632) / 2;
    const toolbar = horizontalPan({ canvasWidth: 1440, pageWidth: 1632, padLeft: 40, padRight: 40, pageLeft: centered });
    assert.equal(toolbar.padLeft, 40);
    assert.equal(toolbar.padRight, 40);
    assert.ok(Math.abs(toolbar.padLeft - toolbar.scrollLeft - centered) < 0.01);

    // Zooming back out until the sides fit returns to the centered layout.
    assert.deepEqual(horizontalPan({ canvasWidth: 1440, pageWidth: 816, padLeft: 40, padRight: 40, pageLeft: 200 }), {
      padLeft: 40,
      padRight: 40,
      scrollLeft: 0,
    });
  });

  it("holds the top of the page when the reader hasn't scrolled, and the middle of the view when they have", () => {
    assert.deepEqual(manualZoomOrigin({ scrollTop: 0, left: 100, top: 80, width: 800, height: 600 }, 108), { x: 500, y: 108 });
    assert.deepEqual(manualZoomOrigin({ scrollTop: 240, left: 100, top: 80, width: 800, height: 600 }, 108), { x: 500, y: 380 });
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

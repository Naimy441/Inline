import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anchorAt, clampZoom, manualZoomOrigin, pinchBox, pinchTransform, scrollForAnchor, stepPinch, touchDistance, touchMidpoint, zoomFromPinch, zoomFromWheel, type PinchFrame } from "./zoom";

describe("document zoom", () => {
  it("stays inside the same range as the zoom menu", () => {
    assert.equal(clampZoom(1), 1);
    assert.equal(clampZoom(3), 2);
    assert.equal(clampZoom(0.1), 0.5);
    assert.equal(clampZoom(Number.NaN), 1);
  });

  it("zooms in when the wheel delta is negative and out when it is positive", () => {
    const zoomIn = zoomFromWheel(1, -100, 0);
    const zoomOut = zoomFromWheel(1, 100, 0);
    assert.ok(zoomIn > 1.05 && zoomIn < 1.2, `zoom in ${zoomIn}`);
    assert.ok(zoomOut < 0.95 && zoomOut > 0.8, `zoom out ${zoomOut}`);
    assert.equal(zoomFromWheel(1, 10_000, 0), 0.5);
    // A line-mode notch is a real step, not a fraction of a percent.
    assert.ok(zoomFromWheel(1, 3, 1) < 0.95);
  });

  it("follows the ratio of two finger distances", () => {
    assert.equal(zoomFromPinch(1, 100, 150), 1.5);
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

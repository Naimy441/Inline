/**
 * Document zoom. The page is scaled with a CSS transform (so text doesn't
 * reflow); these helpers keep that scale inside the menu's range and keep a
 * point on the page under the same screen pixel while the scale changes.
 */

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2;

export function clampZoom(value: number) {
  if (!Number.isFinite(value)) return 1;
  const rounded = Math.round(value * 1000) / 1000;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, rounded));
}

/**
 * Wheel pixels in one deliberate trackpad pinch. That gesture, and a two-finger
 * spread of `PINCH_SPREAD`, each cross from 100% to an end of the 50%–200% range.
 */
const WHEEL_PINCH_PIXELS = 150;
const PINCH_SPREAD = 1.2;

/**
 * Next scale for a ctrl/pinch wheel event. Pinches arrive as a burst of these.
 * About 150 pixels is one pinch and covers most of the zoom range; smaller
 * deltas accumulate. Pinching apart (negative deltaY) zooms in.
 */
export function zoomFromWheel(current: number, deltaY: number, deltaMode = 0) {
  const lines = deltaMode === 1 ? deltaY : deltaMode === 2 ? deltaY * 12 : deltaY / 32;
  const pixels = Math.max(-800, Math.min(800, lines * 32));
  return clampZoom(current * Math.exp(-pixels * (Math.log(2) / WHEEL_PINCH_PIXELS)));
}

/**
 * Next scale for a two-finger pinch. The finger ratio is raised so a normal
 * spread (about a fifth farther, or a fifth closer) covers most of the range
 * instead of matching the fingers one-to-one.
 */
export function zoomFromPinch(startZoom: number, startDistance: number, distance: number) {
  if (!(startDistance > 0) || !(distance > 0)) return clampZoom(startZoom);
  const gain = Math.log(2) / Math.log(PINCH_SPREAD);
  return clampZoom(startZoom * (distance / startDistance) ** gain);
}

/**
 * A pinch drawn on the page stack before React commits it.
 * `left`/`top` are the viewport position of the page's top-left (transform-origin
 * is the top-left, and this ignores the live translate). `width`/`height` are the
 * unscaled layout size. `tx`/`ty` are screen pixels applied after the scale.
 */
export type PinchFrame = {
  left: number;
  top: number;
  width: number;
  height: number;
  tx: number;
  ty: number;
  scale: number;
};

/**
 * Scale the page so `origin` stays on the same screen pixel. Pure arithmetic:
 * a pinch step must not read layout, or each event waits on the page to reflow.
 */
export function stepPinch(frame: PinchFrame, origin: { x: number; y: number }, scale: number): PinchFrame {
  const safe = frame.scale > 0 ? frame.scale : 1;
  const lx = (origin.x - frame.left - frame.tx) / safe;
  const ly = (origin.y - frame.top - frame.ty) / safe;
  return {
    ...frame,
    tx: origin.x - frame.left - lx * scale,
    ty: origin.y - frame.top - ly * scale,
    scale,
  };
}

/** `translate() scale()` with origin at the top-left. Empty when the page is at 1× and unshifted. */
export function pinchTransform(frame: PinchFrame): string {
  const moved = Math.abs(frame.tx) > 0.01 || Math.abs(frame.ty) > 0.01;
  if (Math.abs(frame.scale - 1) < 0.0005 && !moved) return "";
  const translate = moved ? `translate(${frame.tx}px, ${frame.ty}px) ` : "";
  return `${translate}scale(${frame.scale})`;
}

/** Where the live pinch paints the page, in viewport pixels. */
export function pinchBox(frame: PinchFrame) {
  return {
    left: frame.left + frame.tx,
    top: frame.top + frame.ty,
    width: frame.width * frame.scale,
    height: frame.height * frame.scale,
  };
}

export type ZoomAnchor = { clientX: number; clientY: number; fx: number; fy: number };

/** Where `clientX`/`clientY` sits on a frame, as fractions of its box. */
export function anchorAt(frame: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): ZoomAnchor {
  return {
    clientX,
    clientY,
    fx: frame.width > 0 ? (clientX - frame.left) / frame.width : 0.5,
    fy: frame.height > 0 ? (clientY - frame.top) / frame.height : 0.5,
  };
}

/**
 * Scroll offsets that put `anchor` back on its client pixel after the frame
 * has been remeasured. The caller adds the returned deltas by assigning
 * scrollLeft/scrollTop (the browser clamps them).
 */
export function scrollForAnchor(
  scroll: { scrollLeft: number; scrollTop: number },
  frame: { left: number; top: number; width: number; height: number },
  anchor: ZoomAnchor,
) {
  return {
    scrollLeft: scroll.scrollLeft + (frame.left + anchor.fx * frame.width - anchor.clientX),
    scrollTop: scroll.scrollTop + (frame.top + anchor.fy * frame.height - anchor.clientY),
  };
}

/**
 * Where a toolbar or menu zoom should hold still. Horizontally that's the
 * middle of the canvas, so a page that was centered stays centered. At the
 * top of the document the page grows downward; once the reader has scrolled,
 * the middle of the view stays put.
 */
export function manualZoomOrigin(
  canvas: { scrollTop: number; left: number; top: number; width: number; height: number },
  frameTop: number,
) {
  return {
    x: canvas.left + canvas.width / 2,
    y: canvas.scrollTop <= 8 ? frameTop : canvas.top + canvas.height / 2,
  };
}

export function touchDistance(points: Array<{ clientX: number; clientY: number }>) {
  const [a, b] = points;
  if (!a || !b) return 0;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

export function touchMidpoint(points: Array<{ clientX: number; clientY: number }>) {
  const [a, b] = points;
  if (!a || !b) return { x: 0, y: 0 };
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

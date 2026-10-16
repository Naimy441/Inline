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
 * Next scale for a ctrl/pinch wheel event. One mouse notch (about 100 pixels,
 * or a few lines) moves the zoom by about ten percent; smaller trackpad
 * deltas accumulate smoothly. Pinching apart (negative deltaY) zooms in.
 */
export function zoomFromWheel(current: number, deltaY: number, deltaMode = 0) {
  const lines = deltaMode === 1 ? deltaY : deltaMode === 2 ? deltaY * 12 : deltaY / 32;
  const pixels = Math.max(-800, Math.min(800, lines * 32));
  return clampZoom(current * Math.exp(-pixels * 0.001));
}

/** Next scale for a two-finger pinch, relative to the distance when it started. */
export function zoomFromPinch(startZoom: number, startDistance: number, distance: number) {
  if (!(startDistance > 0) || !(distance > 0)) return clampZoom(startZoom);
  return clampZoom(startZoom * (distance / startDistance));
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

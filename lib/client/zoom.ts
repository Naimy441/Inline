/**
 * Document zoom. The page is scaled with a CSS transform (so text doesn't
 * reflow). The toolbar zoom is a lock: pinch and ctrl+scroll can go further in
 * toward the pointer, and zooming out stops on the lock. Landing on the lock
 * centers the page again.
 */

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2;
/** Half an inch, at 96 CSS pixels per inch. Fit leaves this much canvas on each side. */
export const FIT_MARGIN = 48;

function clampRange(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return 1;
  const rounded = Math.round(value * 1000) / 1000;
  return Math.min(max, Math.max(min, rounded));
}

/** A toolbar percentage: the menu's 50%–200% range. */
export function clampZoom(value: number) {
  return clampRange(value, MIN_ZOOM, MAX_ZOOM);
}

/**
 * Pinch and ctrl+scroll may not go below `lock` or above the menu's top.
 * `lock` can sit under 50% when Fit is sizing a narrow window.
 */
export function clampAboveLock(value: number, lock: number) {
  const floor = Number.isFinite(lock) ? lock : MIN_ZOOM;
  return clampRange(value, floor, MAX_ZOOM);
}

/**
 * Scale that puts the page edge to edge in `availableWidth`, with half an inch
 * of background on each side. Wider windows grow past 100%; narrow ones shrink
 * below the menu's 50% floor so the page still fits.
 */
export function fitScale(availableWidth: number, pageWidth: number) {
  if (!(availableWidth > 0) || !(pageWidth > 0)) return 1;
  return clampRange((availableWidth - FIT_MARGIN * 2) / pageWidth, 0.1, MAX_ZOOM);
}

/** Width the floating comment column takes, matching `.canvas.with-comments`. */
export const COMMENT_COLUMN = 296;
/** Spare canvas width `marginFits` requires before comments float beside the page. */
export const COMMENT_ROOM = 376;

/**
 * Width Fit should give up so a fitted page still leaves a comment column.
 * Zero when the canvas is too narrow for that column even after shrinking.
 */
export function commentFitReserve(canvasWidth: number, pageWidth: number) {
  if (!(canvasWidth > 0) || !(pageWidth > 0)) return 0;
  const visual = fitScale(Math.max(0, canvasWidth - COMMENT_COLUMN), pageWidth) * pageWidth;
  return canvasWidth - visual >= COMMENT_ROOM ? COMMENT_COLUMN : 0;
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
  // The lock, not this helper, decides how far a pinch may zoom out.
  return clampRange(current * Math.exp(-pixels * (Math.log(2) / WHEEL_PINCH_PIXELS)), 0.05, MAX_ZOOM);
}

/**
 * Next scale for a two-finger pinch. The finger ratio is raised so a normal
 * spread (about a fifth farther, or a fifth closer) covers most of the range
 * instead of matching the fingers one-to-one.
 */
export function zoomFromPinch(startZoom: number, startDistance: number, distance: number) {
  if (!(startDistance > 0) || !(distance > 0)) return clampRange(startZoom, 0.05, MAX_ZOOM);
  const gain = Math.log(2) / Math.log(PINCH_SPREAD);
  return clampRange(startZoom * (distance / startDistance) ** gain, 0.05, MAX_ZOOM);
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
 * Where one edge of the page sits after a zoom, and how far the canvas scrolls.
 * `pageStart` is that edge relative to the viewport.
 * With `center`, a page that fits stays in the centered layout (base gutters, no
 * scroll) and a wider page is centered. Without it, the page stays at
 * `pageStart`. Gutters grow when that spot would be clamped, and they never
 * shrink below the background padding, so scrolling still reaches the page and
 * the background on both ends.
 */
export function placeOnAxis(input: {
  canvas: number;
  page: number;
  padStart: number;
  padEnd: number;
  pageStart: number;
  center: boolean;
}): { padStart: number; padEnd: number; scroll: number } {
  const padStart = Math.max(0, input.padStart);
  const padEnd = Math.max(0, input.padEnd);
  const { canvas, page } = input;
  if (!(canvas > 0) || !(page > 0)) return { padStart, padEnd, scroll: 0 };
  let pageStart = input.pageStart;
  if (input.center) {
    if (page + padStart + padEnd <= canvas + 0.5) return { padStart, padEnd, scroll: 0 };
    if (page <= canvas + 0.5) {
      const gap = (canvas - page) / 2;
      return { padStart: gap, padEnd: gap, scroll: 0 };
    }
    pageStart = (canvas - page) / 2;
  }
  const minStart = canvas - padEnd - page;
  const maxStart = padStart;
  if (!Number.isFinite(pageStart)) pageStart = (canvas - page) / 2;
  let start = padStart;
  let end = padEnd;
  if (pageStart > maxStart) start = pageStart;
  else if (pageStart < minStart) end = Math.max(0, canvas - page - pageStart);
  return { padStart: start, padEnd: end, scroll: Math.max(0, start - pageStart) };
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

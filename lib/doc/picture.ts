/**
 * How a picture sits in the text, and which part of it is shown.
 *
 * `square` floats the picture so the following text runs beside it. `behind`
 * and `front` take it out of the flow and paint it under or over that text.
 * Crop is the fraction of the source hidden on each edge (left, top, right,
 * bottom). Rotation is degrees clockwise, the same way Word stores it.
 */

export const PICTURE_WRAPS = ["square", "behind", "front"] as const;
export type PictureWrap = (typeof PICTURE_WRAPS)[number];

export type PictureCrop = { l: number; t: number; r: number; b: number };

const CROP_LIMIT = 0.95;

export function pictureWrap(value: unknown): PictureWrap | null {
  return value === "square" || value === "behind" || value === "front" ? value : null;
}

/** A crop that still leaves part of the picture, or null when nothing is hidden. */
export function pictureCrop(value: unknown): PictureCrop | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const sides = (["l", "t", "r", "b"] as const).map((key) => Number(raw[key]));
  if (sides.some((side) => !Number.isFinite(side) || side < 0 || side > CROP_LIMIT)) return null;
  if (sides[0]! + sides[2]! >= 1 || sides[1]! + sides[3]! >= 1) return null;
  if (sides.every((side) => side === 0)) return null;
  const round = (side: number) => Math.round(side * 10000) / 10000;
  return { l: round(sides[0]!), t: round(sides[1]!), r: round(sides[2]!), b: round(sides[3]!) };
}

/** Degrees clockwise in (-180, 180], or null when the picture is upright. */
export function pictureRotate(value: unknown): number | null {
  const degrees = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(degrees)) return null;
  let normalized = ((degrees % 360) + 360) % 360;
  if (normalized > 180) normalized -= 360;
  if (Math.abs(normalized) < 0.01) return null;
  return Math.round(normalized * 100) / 100;
}

/** `10,5,0,0` is the percent hidden from the left, top, right and bottom. */
export function cropToken(crop: PictureCrop): string {
  const percent = (fraction: number) => String(Math.round(fraction * 1000) / 10);
  return [crop.l, crop.t, crop.r, crop.b].map(percent).join(",");
}

export function parseCropToken(raw: string | null | undefined): PictureCrop | null {
  if (!raw) return null;
  const parts = raw.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  return pictureCrop({
    l: parts[0]! / 100,
    t: parts[1]! / 100,
    r: parts[2]! / 100,
    b: parts[3]! / 100,
  });
}

/** Word's `a:srcRect` is in thousandths of a percent (10% is 10000). */
export function cropToSrcRect(crop: PictureCrop) {
  const unit = (fraction: number) => Math.round(fraction * 100000);
  return { l: unit(crop.l), t: unit(crop.t), r: unit(crop.r), b: unit(crop.b) };
}

export function srcRectToCrop(attrs: Record<string, string | undefined>): PictureCrop | null {
  const read = (name: string) => {
    const raw = attrs[name] ?? attrs[`a:${name}`];
    if (raw == null || raw === "") return 0;
    const value = Number(raw);
    return Number.isFinite(value) ? value / 100000 : 0;
  };
  const present = ["l", "t", "r", "b"].some((name) => attrs[name] != null || attrs[`a:${name}`] != null);
  if (!present) return null;
  return pictureCrop({ l: read("l"), t: read("t"), r: read("r"), b: read("b") });
}

/** Word's `a:xfrm rot` is clockwise, in 60,000ths of a degree. */
export function rotateToWord(degrees: number) {
  const normalized = ((degrees % 360) + 360) % 360;
  return Math.round(normalized * 60000);
}

export function rotateFromWord(rot: number) {
  if (!Number.isFinite(rot) || rot === 0) return null;
  return pictureRotate(rot / 60000);
}

/**
 * The window a cropped picture occupies. `displayWidth` is that window's
 * width; the source is scaled so the uncropped part fills it and the rest
 * sits outside, where the frame clips it.
 */
export function croppedFrame(displayWidth: number, naturalWidth: number, naturalHeight: number, crop: PictureCrop | null) {
  const l = crop?.l ?? 0;
  const t = crop?.t ?? 0;
  const r = crop?.r ?? 0;
  const b = crop?.b ?? 0;
  const visW = 1 - l - r;
  const visH = 1 - t - b;
  const width = Math.max(1, displayWidth);
  const height = (width * Math.max(1, naturalHeight) * visH) / (Math.max(1, naturalWidth) * visW);
  const imageWidth = width / visW;
  const imageHeight = height / visH;
  return {
    frameWidth: width,
    frameHeight: height,
    imageWidth,
    imageHeight,
    offsetX: -l * imageWidth,
    offsetY: -t * imageHeight,
  };
}

/**
 * A picture's width as CSS. A bare number is pixels (`480` and `480px` are the
 * same). A percent is a share of the text width (`70%`).
 */
export function pictureWidth(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?%$/.test(raw)) {
    const percent = Number.parseFloat(raw);
    return percent > 0 ? `${percent}%` : null;
  }
  if (/^\d+(\.\d+)?px$/i.test(raw) || /^\d+(\.\d+)?$/.test(raw)) {
    const px = Number.parseFloat(raw);
    return px > 0 ? `${px}px` : null;
  }
  return raw;
}

/** A width attribute (`220px`, `50%`, `220`) in CSS pixels, never wider than the text. */
export function cssPx(width: string | null, container: number, natural: number) {
  let value: number;
  if (!width) value = natural > 0 ? natural : container;
  else if (width.endsWith("%")) value = (Math.max(0, container) * Number.parseFloat(width)) / 100;
  else {
    const parsed = Number.parseFloat(width);
    value = Number.isFinite(parsed) && parsed > 0 ? parsed : natural > 0 ? natural : container;
  }
  if (!(value > 0)) return container > 0 ? container : 1;
  if (container > 0 && value > container) return container;
  return value;
}

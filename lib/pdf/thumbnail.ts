// Draws a page from the PDF page model onto a small canvas, for the cover
// shown on the home page. Text is drawn with the browser's fonts closest to
// the PDF's standard fonts; at this size that reads the same.

import type { PdfPage, RGB, StandardFont } from "@/lib/pdf/pdfWriter";

export const THUMBNAIL_WIDTH = 320;

export type ThumbnailTheme = "light" | "dark";

/** The dark theme's paper (--paper in app/styles/base.css). */
const DARK_PAPER: RGB = [0x26 / 255, 0x26 / 255, 0x24 / 255];

/**
 * A color as the dark theme would show it: lightness flipped into the range
 * between the dark paper and its text, hue and saturation kept, so black ink
 * reads as the light text and white fills as the paper.
 */
export function darkColor([r, g, b]: RGB): RGB {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const next = 0.145 + (1 - l) * 0.75;
  const c = (1 - Math.abs(2 * next - 1)) * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = next - c / 2;
  const [r1, g1, b1] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return [r1 + m, g1 + m, b1 + m];
}

function css([r, g, b]: RGB) {
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

function canvasFont(font: StandardFont, size: number) {
  const family = font.startsWith("Times") ? '"Times New Roman", Times, serif' : font.startsWith("Courier") ? '"Courier New", Courier, monospace' : "Arial, Helvetica, sans-serif";
  const italic = /Oblique|Italic/.test(font) ? "italic " : "";
  const bold = /Bold/.test(font) ? "bold " : "";
  return `${italic}${bold}${size}px ${family}`;
}

/** A small WebP (or JPEG where WebP isn't supported) of the page, or null if it couldn't be drawn. */
export async function renderThumbnail(page: PdfPage, width = THUMBNAIL_WIDTH, theme: ThumbnailTheme = "light"): Promise<Blob | null> {
  const color = theme === "dark" ? (rgb: RGB) => css(darkColor(rgb)) : css;
  const scale = width / page.width;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round(page.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = theme === "dark" ? css(DARK_PAPER) : "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "alphabetic";
  for (const item of page.items) {
    if (item.kind === "rect") {
      ctx.fillStyle = color(item.fill);
      ctx.fillRect(item.x * scale, item.y * scale, item.width * scale, item.height * scale);
    } else if (item.kind === "line") {
      ctx.strokeStyle = color(item.color);
      ctx.lineWidth = Math.max(0.5, item.width * scale);
      ctx.beginPath();
      ctx.moveTo(item.x1 * scale, item.y1 * scale);
      ctx.lineTo(item.x2 * scale, item.y2 * scale);
      ctx.stroke();
    } else if (item.kind === "text") {
      ctx.fillStyle = color(item.color);
      ctx.font = canvasFont(item.font, item.size * scale);
      ctx.fillText(item.text, item.x * scale, item.y * scale);
    } else if (item.kind === "image") {
      const bitmap = await createImageBitmap(new Blob([item.jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" })).catch(() => null);
      if (bitmap) {
        // Ink drawn as a picture (equations) turns light on the dark page; photos stay as they are.
        if (theme === "dark" && item.ink) ctx.filter = "invert(0.9) hue-rotate(180deg)";
        ctx.drawImage(bitmap, item.x * scale, item.y * scale, item.width * scale, item.height * scale);
        ctx.filter = "none";
      }
    }
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.72));
  if (blob?.type === "image/webp") return blob;
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.72));
}

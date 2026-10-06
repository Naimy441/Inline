// Draws a page from the PDF page model onto a small canvas, for the cover
// shown on the home page. Text is drawn with the browser's fonts closest to
// the PDF's standard fonts; at this size that reads the same.

import type { PdfPage, RGB, StandardFont } from "@/lib/pdf/pdfWriter";

export const THUMBNAIL_WIDTH = 320;

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
export async function renderThumbnail(page: PdfPage, width = THUMBNAIL_WIDTH): Promise<Blob | null> {
  const scale = width / page.width;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round(page.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "alphabetic";
  for (const item of page.items) {
    if (item.kind === "rect") {
      ctx.fillStyle = css(item.fill);
      ctx.fillRect(item.x * scale, item.y * scale, item.width * scale, item.height * scale);
    } else if (item.kind === "line") {
      ctx.strokeStyle = css(item.color);
      ctx.lineWidth = Math.max(0.5, item.width * scale);
      ctx.beginPath();
      ctx.moveTo(item.x1 * scale, item.y1 * scale);
      ctx.lineTo(item.x2 * scale, item.y2 * scale);
      ctx.stroke();
    } else if (item.kind === "text") {
      ctx.fillStyle = css(item.color);
      ctx.font = canvasFont(item.font, item.size * scale);
      ctx.fillText(item.text, item.x * scale, item.y * scale);
    } else if (item.kind === "image") {
      const bitmap = await createImageBitmap(new Blob([item.jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" })).catch(() => null);
      if (bitmap) ctx.drawImage(bitmap, item.x * scale, item.y * scale, item.width * scale, item.height * scale);
    }
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.72));
  if (blob?.type === "image/webp") return blob;
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.72));
}

import type { PdfTextLine, PdfTextRun } from "@/lib/pdf/import/types";

/**
 * The colors a page's text is drawn in, read off the page's picture: pdf.js's
 * text layer has no colors, and the drawing operators that set them don't say
 * which text they color. For each run, the pixels that differ most from the
 * paper around it are its letters; their color is the run's.
 */

export type RgbaBitmap = { width: number; height: number; data: Uint8Array };

/** Colors this close to black are black (antialiasing and print profiles shift it a little). */
const NEAR_BLACK = 70;

/** A run's color as #rrggbb, by run, for every run whose letters could be seen. `scale` is the picture's pixels per point. */
export function runColors(bitmap: RgbaBitmap, scale: number, lines: readonly PdfTextLine[]): Map<PdfTextRun, string> {
  const colors = new Map<PdfTextRun, string>();
  for (const line of lines) {
    for (const run of line.runs) {
      if (!run.text.trim()) continue;
      const baseline = line.baseline + (run.dy ?? 0);
      const color = inkColor(bitmap, scale, { x: run.x, y: baseline - run.size * 0.72, width: run.width, height: run.size * 0.92 });
      if (color) colors.set(run, color);
    }
  }
  return settle(colors);
}

/**
 * One color for each color the page uses: a thin letter reads a little off
 * its color ("." and "=" in the same purple come out a few steps apart), so
 * colors this close are the one most of the page's letters have.
 */
function settle(colors: Map<PdfTextRun, string>) {
  const weight = new Map<string, number>();
  for (const [run, color] of colors) weight.set(color, (weight.get(color) ?? 0) + run.text.replace(/\s/g, "").length);
  const rgb = (color: string) => [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16)) as [number, number, number];
  const chosen: string[] = [];
  const to = new Map<string, string>();
  for (const [color] of [...weight].sort((a, b) => b[1] - a[1])) {
    const [r, g, b] = rgb(color);
    const near = chosen.find((other) => {
      const [r2, g2, b2] = rgb(other);
      return Math.hypot(r - r2, g - g2, b - b2) < 40;
    });
    if (near) to.set(color, near);
    else chosen.push(color);
  }
  for (const [run, color] of colors) colors.set(run, to.get(color) ?? color);
  return colors;
}

/** The color of what is drawn in a box (points), against the paper around it; null when there's nothing to see. */
export function inkColor(bitmap: RgbaBitmap, scale: number, box: { x: number; y: number; width: number; height: number }): string | null {
  const left = Math.max(0, Math.floor(box.x * scale));
  const top = Math.max(0, Math.floor(box.y * scale));
  const right = Math.min(bitmap.width, Math.ceil((box.x + box.width) * scale));
  const bottom = Math.min(bitmap.height, Math.ceil((box.y + box.height) * scale));
  if (right - left < 1 || bottom - top < 1) return null;
  // The paper: the lightest color in the box (letters don't fill it).
  let paper = [255, 255, 255];
  let lightest = -1;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const i = (y * bitmap.width + x) * 4;
      const light = bitmap.data[i]! + bitmap.data[i + 1]! + bitmap.data[i + 2]!;
      if (light > lightest) {
        lightest = light;
        paper = [bitmap.data[i]!, bitmap.data[i + 1]!, bitmap.data[i + 2]!];
      }
    }
  }
  // The letters: the pixels furthest from the paper. Their edges blend into it, so only the strongest count.
  const found: Array<{ distance: number; r: number; g: number; b: number }> = [];
  let strongest = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const i = (y * bitmap.width + x) * 4;
      const r = bitmap.data[i]!;
      const g = bitmap.data[i + 1]!;
      const b = bitmap.data[i + 2]!;
      const distance = Math.hypot(r - paper[0]!, g - paper[1]!, b - paper[2]!);
      if (distance < 40) continue;
      strongest = Math.max(strongest, distance);
      found.push({ distance, r, g, b });
    }
  }
  if (!found.length) return null;
  const core = found.filter((pixel) => pixel.distance >= strongest * 0.8);
  const mean = (key: "r" | "g" | "b") => Math.round(core.reduce((sum, pixel) => sum + pixel[key], 0) / core.length);
  const [r, g, b] = [mean("r"), mean("g"), mean("b")];
  if (r < NEAR_BLACK && g < NEAR_BLACK && b < NEAR_BLACK && Math.max(r, g, b) - Math.min(r, g, b) < 30) return "#000000";
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

import type { RgbaBitmap } from "@/lib/pdf/import/inkColor";
import type { PdfBox, PdfPageAnalysis } from "@/lib/pdf/import/types";

/**
 * What the page's picture shows that its text layer, rules, pictures and
 * drawings don't account for: text drawn as a picture or as outlines (a
 * notebook's "In [1]:" labels, a scanned stamp), a logo. Found on a grid of
 * one-point cells: inked cells away from everything known, gathered into
 * regions.
 */
export function unexplainedMarks(bitmap: RgbaBitmap, scale: number, page: PdfPageAnalysis): PdfBox[] {
  const columns = Math.ceil(page.width);
  const rows = Math.ceil(page.height);
  const known = new Uint8Array(columns * rows);
  const cover = (box: PdfBox, pad: number) => {
    const x0 = Math.max(0, Math.floor(box.x - pad));
    const y0 = Math.max(0, Math.floor(box.y - pad));
    const x1 = Math.min(columns, Math.ceil(box.x + box.width + pad));
    const y1 = Math.min(rows, Math.ceil(box.y + box.height + pad));
    for (let y = y0; y < y1; y += 1) known.fill(1, y * columns + x0, y * columns + Math.max(x0, x1));
  };
  for (const line of page.lines) cover({ x: line.box.x, y: line.baseline - line.size, width: line.box.width, height: line.size * 1.3 }, 1.5);
  for (const image of page.images) cover(image.box, 1);
  for (const box of page.graphics) cover(box, 2);
  for (const rule of page.rules) {
    // A frame is its four sides, not what's inside it.
    if (rule.kind !== "frame") {
      cover(rule.box, 1.5);
      continue;
    }
    const { x, y, width, height } = rule.box;
    const w = rule.width + 1;
    cover({ x, y, width, height: w }, 1);
    cover({ x, y: y + height - w, width, height: w }, 1);
    cover({ x, y, width: w, height }, 1);
    cover({ x: x + width - w, y, width: w, height }, 1);
  }
  // Inked cells nothing explains.
  const inked = new Uint8Array(columns * rows);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      if (known[y * columns + x]) continue;
      const px0 = Math.floor(x * scale);
      const py0 = Math.floor(y * scale);
      const px1 = Math.min(bitmap.width, Math.ceil((x + 1) * scale));
      const py1 = Math.min(bitmap.height, Math.ceil((y + 1) * scale));
      search: for (let py = py0; py < py1; py += 1) {
        for (let px = px0; px < px1; px += 1) {
          const i = (py * bitmap.width + px) * 4;
          if (bitmap.data[i + 3]! > 30 && bitmap.data[i]! + bitmap.data[i + 1]! + bitmap.data[i + 2]! < 3 * 200) {
            inked[y * columns + x] = 1;
            break search;
          }
        }
      }
    }
  }
  // Regions: inked cells joined across small gaps (the letters of a word, the words of a label).
  const seen = new Uint8Array(columns * rows);
  const regions: PdfBox[] = [];
  const REACH_X = 9;
  const REACH_Y = 2;
  for (let start = 0; start < inked.length; start += 1) {
    if (!inked[start] || seen[start]) continue;
    let left = columns;
    let top = rows;
    let right = 0;
    let bottom = 0;
    let cells = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const at = stack.pop()!;
      const x = at % columns;
      const y = (at - x) / columns;
      cells += 1;
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + 1);
      for (let dy = -REACH_Y; dy <= REACH_Y; dy += 1) {
        for (let dx = -REACH_X; dx <= REACH_X; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= columns || ny >= rows) continue;
          const next = ny * columns + nx;
          if (inked[next] && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    // Specks (a stray pixel, the tail of a letter) aren't worth a mention.
    if (cells < 6 || (right - left) * (bottom - top) < 12) continue;
    regions.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return regions.sort((a, b) => a.y - b.y || a.x - b.x);
}

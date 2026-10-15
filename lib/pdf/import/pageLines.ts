import type { PdfPage } from "@/lib/pdf/pdfWriter";

/**
 * The lines of text on a page of Inline's PDF page model (lib/pdf/pageSnapshot.ts
 * places each word on its own), for comparing a rebuilt page with the original
 * PDF's lines (lib/agent/pdfTools.ts): words on one baseline become one line.
 */

export type PageLine = { x: number; y: number; size: number; text: string };

export function pageLines(page: PdfPage): PageLine[] {
  const words = page.items
    .filter((item) => item.kind === "text" && item.text.trim())
    .map((item) => item as Extract<PdfPage["items"][number], { kind: "text" }>)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Array<{ y: number; size: number; words: typeof words }> = [];
  for (const word of words) {
    const line = lines.find((item) => Math.abs(item.y - word.y) <= Math.max(item.size, word.size) * 0.3);
    if (line) line.words.push(word);
    else lines.push({ y: word.y, size: word.size, words: [word] });
  }
  return lines
    .map((line) => {
      const sorted = line.words.sort((a, b) => a.x - b.x);
      let text = "";
      let right = -Infinity;
      for (const word of sorted) {
        const gap = word.x - right;
        if (text && gap > word.size * 0.15 && !/\s$/.test(text)) text += " ";
        text += word.text;
        right = word.x + (word.width ?? word.text.length * word.size * 0.5);
      }
      const size = Math.max(...sorted.map((word) => word.size));
      return { x: Math.round(sorted[0]!.x * 10) / 10, y: Math.round(line.y * 10) / 10, size, text: text.replace(/\s+/g, " ").trim() };
    })
    .sort((a, b) => a.y - b.y);
}

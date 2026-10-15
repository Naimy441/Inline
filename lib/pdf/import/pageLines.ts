import type { PdfPage } from "@/lib/pdf/pdfWriter";

/**
 * The lines of text on a page of Inline's PDF page model (lib/pdf/pageSnapshot.ts
 * places each word on its own), for comparing a rebuilt page with the original
 * PDF's lines (lib/agent/pdfTools.ts): words on one baseline become one line.
 */

export type PageLine = { x: number; y: number; size: number; text: string };

/**
 * An equation's LaTeX as the words a PDF's text layer would have for it:
 * "\\operatorname{Var}(aY + b)" reads "Var(aY + b)", "\\frac{1}{2}" "1 2".
 */
export function texText(tex: string) {
  return tex
    .replace(/\\(?:operatorname|mathrm|mathbf|mathit|mathbb|mathcal|mathsf|text|textbf|textit|boldsymbol)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, "")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[{}^_&\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type Word = { x: number; y: number; size: number; text: string; width?: number };

export function pageLines(page: PdfPage): PageLine[] {
  const words: Word[] = [];
  for (const item of page.items) {
    if (item.kind === "text" && item.text.trim()) words.push({ x: item.x, y: item.y, size: item.size, text: item.text, width: item.width });
    // An equation drawn as a picture stands in by its LaTeX, on the line it sits on (its baseline about a quarter up from its bottom).
    else if (item.kind === "image" && item.tex) words.push({ x: item.x, y: item.y + item.height * 0.75, size: Math.min(24, item.height * 0.75), text: texText(item.tex), width: item.width });
  }
  words.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Array<{ y: number; size: number; words: Word[] }> = [];
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

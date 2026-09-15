import { lintWriting, PAGE_WORDS } from "@/lib/writing/lint";
import { parseWritingTargets, reviewProposedWriting, type WritingTargets } from "@/lib/writing/review";

export { PAGE_WORDS };

const CAPS_RUN = /[A-Z]{8,}(?:\s+[A-Z]{4,}){3,}/;

export function tidyDocumentText(text: string) {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/ {2,}/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function leftoverWhitespaceIssues(text: string): string[] {
  const issues: string[] = [];
  if (/\u00a0/.test(text)) issues.push("nbsp");
  if (/ {2,}/.test(text)) issues.push("double-space");
  if (/[ \t]+\n/.test(text)) issues.push("trailing-space-before-newline");
  if (/\n[ \t]+/.test(text)) issues.push("indent-after-newline");
  if (/\n{3,}/.test(text)) issues.push("extra-blank-lines");
  if (text.trim() && /^\s/.test(text)) issues.push("leading-whitespace");
  if (text.trim() && /\s$/.test(text)) issues.push("trailing-whitespace");
  if (/ +[,.;:!?]/.test(text)) issues.push("space-before-punctuation");
  return issues;
}

export function blankPageIssues(pages: Array<{ text: string }>): string[] {
  if (pages.length <= 1) {
    return pages[0] && !pages[0].text.trim() && pages[0].text.length > 0 ? ["blank-only-page"] : [];
  }
  return pages.flatMap((page, index) => (page.text.trim() ? [] : [`blank-page-${index + 1}`]));
}

export function messyFormattingIssues(text: string): string[] {
  const issues = leftoverWhitespaceIssues(text);
  if (CAPS_RUN.test(text)) issues.push("shouting-caps");
  if (/\t/.test(text)) issues.push("tabs");
  if (/(?:^|\n)[^\n]{0,40}\n[^\n]{0,40}\n[^\n]{0,40}\n/.test(text) && text.split("\n").filter((line) => line.trim() && line.trim().length < 40).length >= 6) {
    issues.push("broken-short-lines");
  }
  return issues;
}

export function markdownListIssues(text: string, kind: "ul" | "ol", minItems: number): string[] {
  const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const items =
    kind === "ul"
      ? lines.filter((line) => /^[-*•]/.test(line))
      : lines.filter((line) => /^\d+[.)]/.test(line));
  if (items.length < minItems) {
    return [`expected at least ${minItems} ${kind === "ul" ? "bullet" : "numbered"} items, found ${items.length}`];
  }
  return [];
}

export function markdownTableIssues(text: string, minRows: number, minCols: number): string[] {
  const rows = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|") && !/^\|[\s:-]+\|$/.test(line));
  if (rows.length < minRows) return [`expected at least ${minRows} table rows, found ${rows.length}`];
  const cols = rows.map((row) => row.split("|").filter((cell) => cell.trim() !== "").length);
  if (cols.some((count) => count < minCols)) {
    return [`expected at least ${minCols} columns`];
  }
  return [];
}

export type LengthSpec =
  | { kind: "paragraphs"; value: number }
  | { kind: "sentences"; value: number }
  | { kind: "words"; value: number; slack?: number }
  | { kind: "pages"; value: number }
  | { kind: "one_page_exact" }
  | { kind: "one_page_brim" };

export function gradeLength(text: string, spec: LengthSpec): { ok: boolean; detail: string } {
  const lint = lintWriting(text, 1);
  if (spec.kind === "paragraphs") {
    return cmp("paragraphs", lint.paragraphs, spec.value);
  }
  if (spec.kind === "sentences") {
    return cmp("sentences", lint.sentences, spec.value);
  }
  if (spec.kind === "words") {
    const slack = spec.slack ?? Math.max(1, Math.round(spec.value * 0.08));
    const ok = Math.abs(lint.words - spec.value) <= slack;
    return { ok, detail: `${lint.words} words (target ${spec.value} ±${slack})` };
  }
  if (spec.kind === "pages") {
    return cmp("pages", lint.pages, spec.value);
  }
  if (spec.kind === "one_page_exact") {
    const ok = lint.words >= 420 && lint.words <= 520;
    return { ok, detail: `${lint.words} words, ${lint.pages} lint pages (target one page ≈${PAGE_WORDS} words)` };
  }
  const ok = lint.words >= PAGE_WORDS - 25 && lint.words <= PAGE_WORDS;
  return { ok, detail: `${lint.words} words (fill one page: ${PAGE_WORDS - 25}–${PAGE_WORDS})` };
}

export function gradePromptLength(prompt: string, text: string): { ok: boolean; detail: string; targets: WritingTargets | null } {
  const brim = /\b(brim|fill(?:ed)?(?:\s+(?:out|up))?(?:\s+to(?:\s+the)?\s+brim)?|to the brim)\b/i.test(prompt);
  const fullPage = /\b(full page|entire page|whole page|fill(?:ed)? one page|one page exactly|exactly one page|exactly 1 page)\b/i.test(prompt);
  if (brim) {
    const grade = gradeLength(text, { kind: "one_page_brim" });
    return { ...grade, targets: { scope: "document", pages: { value: 1, mode: "exact" }, words: { value: PAGE_WORDS, mode: "min" } } };
  }
  if (fullPage) {
    const grade = gradeLength(text, { kind: "one_page_exact" });
    return { ...grade, targets: { scope: "document", pages: { value: 1, mode: "exact" } } };
  }
  const targets = parseWritingTargets(prompt);
  if (!targets) return { ok: true, detail: "no length target", targets: null };
  const review = reviewProposedWriting("", [{ find: "", replace: text }], { ...targets, scope: "document" });
  return { ok: review.ok, detail: review.misses.join(" ") || review.summary, targets };
}

export function words(count: number, stem = "word") {
  return Array.from({ length: count }, (_, index) => `${stem}${index + 1}`).join(" ");
}

export function sentences(count: number) {
  return Array.from({ length: count }, (_, index) => `This is sentence number ${index + 1}.`).join(" ");
}

export function paragraphs(count: number) {
  return Array.from({ length: count }, (_, index) => `Paragraph ${index + 1} has enough words to count as real prose for this check.`).join("\n\n");
}

function cmp(label: string, actual: number, expected: number) {
  return { ok: actual === expected, detail: `${label} is ${actual}, expected ${expected}` };
}

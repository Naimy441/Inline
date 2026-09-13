import type { AgentEditDraft } from "@/lib/agent/types";
import { lintWriting, summarizeLint, type WritingLint } from "@/lib/writing/lint";

export type QuantityMode = "exact" | "min" | "max";

export type QuantityTarget = {
  value: number;
  mode: QuantityMode;
  floor?: number;
};

export type WritingScope = "document" | "insert" | "chunk";

export type WritingTargets = {
  words?: QuantityTarget;
  paragraphs?: QuantityTarget;
  sentences?: QuantityTarget;
  pages?: QuantityTarget;
  scope: WritingScope;
};

export type WritingReview = {
  ok: boolean;
  summary: string;
  lint: WritingLint;
  misses: string[];
};

const WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

export function countText(text: string) {
  const lint = lintWriting(text, 1);
  return {
    words: lint.words,
    sentences: lint.sentences,
    paragraphs: lint.paragraphs,
    characters: lint.characters,
    pages: lint.pages,
  };
}

export function parseWritingTargets(prompt: string): WritingTargets | null {
  const text = prompt.toLowerCase();
  const targets: WritingTargets = { scope: inferScope(text) };

  const range = text.match(
    /(?:between|from)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:and|to)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(words?|paragraphs?|sentences?|pages?)/,
  );
  if (range) {
    const low = parseAmount(range[1]);
    const high = parseAmount(range[2]);
    const key = unitKey(range[3]);
    if (low && high && key) targets[key] = { value: Math.max(low, high), mode: "max", floor: Math.min(low, high) };
  }

  const hyphen = text.match(/(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[-\s]word(?:s)?\b/);
  if (hyphen) {
    const value = parseAmount(hyphen[1]);
    if (value) targets.words = { value, mode: "exact" };
  }

  const pattern =
    /(at least|no fewer than|minimum|min|over|more than|exactly|precisely|just|at most|no more than|under|less than|up to|maximum|max|fewer than)?\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a|an)\s+(words?|paragraphs?|sentences?|pages?)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const value = parseAmount(match[2]);
    const key = unitKey(match[3]);
    if (!value || !key || targets[key]) continue;
    if ((match[2] === "a" || match[2] === "an") && !/\b(add|write|insert|make|need|want|give|draft)\b/.test(text.slice(Math.max(0, match.index - 28), match.index))) {
      continue;
    }
    if (key === "pages" && /page\s+numbers?/.test(text)) continue;
    const hint = (match[1] ?? "").trim();
    const next: QuantityTarget = { value, mode: "exact" };
    if (hint === "over" || hint === "more than") {
      next.value = value + 1;
      next.mode = "min";
    } else if (hint === "at least" || hint === "no fewer than" || hint === "minimum" || hint === "min") {
      next.mode = "min";
    } else if (
      hint === "at most" ||
      hint === "no more than" ||
      hint === "under" ||
      hint === "less than" ||
      hint === "up to" ||
      hint === "maximum" ||
      hint === "max" ||
      hint === "fewer than"
    ) {
      next.mode = "max";
    }
    targets[key] = next;
  }

  if (!targets.words && !targets.paragraphs && !targets.sentences && !targets.pages) return null;
  return targets;
}

export function targetsFromToolArgs(args: Record<string, unknown>): WritingTargets | null {
  const targets: WritingTargets = { scope: typeof args.scope === "string" ? (args.scope as WritingScope) : "chunk" };
  for (const key of ["words", "paragraphs", "sentences", "pages"] as const) {
    const raw = args[key];
    const min = args[`min${key[0].toUpperCase()}${key.slice(1)}`];
    const max = args[`max${key[0].toUpperCase()}${key.slice(1)}`];
    if (typeof raw === "number" && raw > 0) targets[key] = { value: Math.round(raw), mode: "exact" };
    else if (typeof min === "number" && min > 0) targets[key] = { value: Math.round(min), mode: "min" };
    else if (typeof max === "number" && max > 0) targets[key] = { value: Math.round(max), mode: "max" };
  }
  if (!targets.words && !targets.paragraphs && !targets.sentences && !targets.pages) return null;
  return targets;
}

export function previewEdits(document: string, edits: AgentEditDraft[]) {
  let next = document;
  for (const edit of edits) {
    if (!edit.find.trim()) {
      next = next.trim() ? `${next.replace(/\s*$/, "")}\n\n${edit.replace}` : edit.replace;
      continue;
    }
    const at = indexOfLoose(next, edit.find);
    if (at < 0) continue;
    next = next.slice(0, at) + edit.replace + next.slice(at + edit.find.length);
  }
  return next;
}

export function reviewProposedWriting(
  document: string,
  edits: AgentEditDraft[],
  targets: WritingTargets | null,
  pageCount?: number,
): WritingReview {
  const proposed = previewEdits(document, edits);
  const lint = lintWriting(proposed, pageCount ?? 1);
  const original = lintWriting(document, pageCount ?? 1);
  const chunks = edits.map((edit) => countText(edit.replace));
  const inserted = {
    words: Math.max(0, lint.words - original.words),
    paragraphs: Math.max(0, lint.paragraphs - original.paragraphs),
    sentences: Math.max(0, lint.sentences - original.sentences),
    pages: lint.pages,
  };
  const measured = measureForScope(targets?.scope ?? "document", lint, inserted, chunks);
  const misses: string[] = [];
  if (targets) {
    for (const key of ["words", "paragraphs", "sentences", "pages"] as const) {
      const target = targets[key];
      if (!target) continue;
      if (!quantityMatches(measured[key], target, key)) {
        misses.push(
          `${labelFor(key)} is ${measured[key]}, target is ${target.mode} ${target.value}${targets.scope === "insert" ? " added" : targets.scope === "chunk" ? " in the new text" : ""}.`,
        );
      }
    }
  }
  return {
    ok: misses.length === 0,
    summary: `${summarizeLint(lint)}${misses.length ? ` Misses: ${misses.join(" ")}` : ""}`,
    lint,
    misses,
  };
}

export function formatReviewFeedback(review: WritingReview, targets: WritingTargets | null) {
  const lines = [
    "Output lint on the proposed document:",
    review.summary,
    `Counts: ${review.lint.words} words, ${review.lint.paragraphs} paragraphs, ${review.lint.sentences} sentences, ~${review.lint.pages} pages.`,
  ];
  if (targets) {
    lines.push(
      `User targets: ${[
        targets.words && `${modeLabel(targets.words)} ${targets.words.value} words`,
        targets.paragraphs && `${modeLabel(targets.paragraphs)} ${targets.paragraphs.value} paragraphs`,
        targets.sentences && `${modeLabel(targets.sentences)} ${targets.sentences.value} sentences`,
        targets.pages && `${modeLabel(targets.pages)} ${targets.pages.value} pages`,
      ]
        .filter(Boolean)
        .join("; ") || "none"}.`,
    );
  }
  if (review.misses.length) {
    lines.push("Fix the edits so these targets pass. Do not mention lint or tools to the user.");
  }
  return lines.join("\n");
}

function inferScope(text: string): WritingScope {
  if (/\b(sentence|this line|this sentence|that sentence)\b/.test(text) || /[-\s]word\b/.test(text)) return "chunk";
  if (/\b(rewrite|replace|make this|turn this|into)\b/.test(text)) return "document";
  if (/\b(add|insert|append|new|write)\b/.test(text)) return "insert";
  return "document";
}

function parseAmount(raw: string) {
  const named = WORDS[raw.toLowerCase()];
  if (named) return named;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function unitKey(unit: string): keyof Pick<WritingTargets, "words" | "paragraphs" | "sentences" | "pages"> | null {
  if (unit.startsWith("word")) return "words";
  if (unit.startsWith("paragraph")) return "paragraphs";
  if (unit.startsWith("sentence")) return "sentences";
  if (unit.startsWith("page")) return "pages";
  return null;
}

function measureForScope(
  scope: WritingScope,
  lint: WritingLint,
  inserted: { words: number; paragraphs: number; sentences: number; pages: number },
  chunks: Array<{ words: number; paragraphs: number; sentences: number; pages: number }>,
) {
  if (scope === "insert") return inserted;
  if (scope === "chunk") {
    const last = chunks[chunks.length - 1];
    return last ?? { words: lint.words, paragraphs: lint.paragraphs, sentences: lint.sentences, pages: lint.pages };
  }
  return { words: lint.words, paragraphs: lint.paragraphs, sentences: lint.sentences, pages: lint.pages };
}

function quantityMatches(actual: number, target: QuantityTarget, key: "words" | "paragraphs" | "sentences" | "pages") {
  if (target.floor != null) return actual >= target.floor && actual <= target.value;
  if (target.mode === "min") return actual >= target.value;
  if (target.mode === "max") return actual <= target.value;
  const slack = key === "words" ? Math.max(1, Math.round(target.value * 0.08)) : 0;
  return Math.abs(actual - target.value) <= slack;
}

function modeLabel(target: QuantityTarget) {
  if (target.mode === "min") return "at least";
  if (target.mode === "max") return "at most";
  return "exactly";
}

function labelFor(key: "words" | "paragraphs" | "sentences" | "pages") {
  return key;
}

function indexOfLoose(haystack: string, needle: string) {
  const exact = haystack.indexOf(needle);
  if (exact >= 0) return exact;
  return haystack.replace(/\s+/g, " ").indexOf(needle.replace(/\s+/g, " "));
}

export type LintSeverity = "info" | "warn" | "error";

export type LintIssue = {
  id: string;
  code: string;
  severity: LintSeverity;
  title: string;
  detail: string;
  find?: string;
};

export type WritingLint = {
  words: number;
  characters: number;
  sentences: number;
  paragraphs: number;
  pages: number;
  uniqueWords: number;
  diversity: number;
  avgSentence: number;
  readingEase: number;
  gradeLevel: number;
  vocabularyLevel: "elementary" | "middle" | "high school" | "college" | "graduate";
  issues: LintIssue[];
};

export const PAGE_WORDS = 500;

export function lintWriting(text: string, pageCount = 1): WritingLint {
  const clean = text.replace(/\s+/g, " ").trim();
  const words = tokenize(clean);
  const sentences = splitSentences(clean);
  const paragraphs = text
    .split(/\n{2,}|\r\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const unique = new Set(words.map((word) => word.toLowerCase()));
  const syllables = words.reduce((sum, word) => sum + countSyllables(word), 0);
  const sentenceCount = Math.max(1, sentences.length);
  const wordCount = Math.max(1, words.length);
  const avgSentence = wordCount / sentenceCount;
  const readingEase = 206.835 - 1.015 * (wordCount / sentenceCount) - 84.6 * (syllables / wordCount);
  const gradeLevel = 0.39 * (wordCount / sentenceCount) + 11.8 * (syllables / wordCount) - 15.59;
  const diversity = unique.size / wordCount;
  const pages = Math.max(pageCount, Math.max(1, Math.ceil(wordCount / PAGE_WORDS)));
  const issues: LintIssue[] = [];

  if (!clean) {
    issues.push({
      id: "empty",
      code: "empty",
      severity: "info",
      title: "Empty document",
      detail: "There is no text to diagnose yet.",
    });
  }
  if (wordCount > 0 && wordCount < 40) {
    issues.push({
      id: "short",
      code: "length",
      severity: "info",
      title: "Very short draft",
      detail: `${wordCount} words. Most templates work better after a first full pass.`,
    });
  }
  if (pages > 8) {
    issues.push({
      id: "long",
      code: "pages",
      severity: "warn",
      title: "Long document",
      detail: `About ${pages} pages. Retrieval will keep edits grounded in the relevant passages.`,
    });
  }
  if (avgSentence > 28) {
    issues.push({
      id: "sentences",
      code: "sentences",
      severity: "warn",
      title: "Long sentences",
      detail: `Average sentence is ${avgSentence.toFixed(1)} words. Break a few for rhythm.`,
      find: longestSentence(sentences),
    });
  }
  if (diversity < 0.38 && wordCount > 80) {
    issues.push({
      id: "vocab",
      code: "diversity",
      severity: "warn",
      title: "Low vocabulary diversity",
      detail: `Type-token ratio is ${(diversity * 100).toFixed(0)}%. Repeat less, or vary verbs.`,
    });
  }
  if (gradeLevel > 16 && wordCount > 40) {
    issues.push({
      id: "grade",
      code: "level",
      severity: "info",
      title: "Graduate-level density",
      detail: `Estimated grade ${Math.max(1, Math.round(gradeLevel))}. Fine for academic work, heavy for general readers.`,
    });
  }
  if (paragraphs.length <= 1 && wordCount > 180) {
    issues.push({
      id: "paragraphs",
      code: "paragraphs",
      severity: "warn",
      title: "Needs paragraph breaks",
      detail: "The draft is a single block. Split it so the page can breathe.",
    });
  }

  return {
    words: words.length,
    characters: clean.length,
    sentences: sentences.length,
    paragraphs: Math.max(paragraphs.length, clean ? 1 : 0),
    pages,
    uniqueWords: unique.size,
    diversity,
    avgSentence,
    readingEase,
    gradeLevel,
    vocabularyLevel: vocabBand(gradeLevel),
    issues,
  };
}

export function summarizeLint(lint: WritingLint) {
  return [
    `${lint.words} words, ${lint.paragraphs} paragraphs, ~${lint.pages} pages`,
    `Vocabulary diversity ${(lint.diversity * 100).toFixed(0)}% (${lint.uniqueWords} unique)`,
    `Reading ease ${lint.readingEase.toFixed(0)}, grade ${Math.max(0, Math.round(lint.gradeLevel))} (${lint.vocabularyLevel})`,
    lint.issues.length ? `Flags: ${lint.issues.map((issue) => issue.title).join("; ")}` : "No structural flags.",
  ].join(". ");
}

function tokenize(text: string) {
  return text.match(/[A-Za-z0-9’']+/g) ?? [];
}

function splitSentences(text: string) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function longestSentence(sentences: string[]) {
  return sentences.reduce((best, item) => (item.length > best.length ? item : best), "");
}

function countSyllables(word: string) {
  const clean = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!clean) return 1;
  if (clean.length <= 3) return 1;
  const groups = clean.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

function vocabBand(grade: number): WritingLint["vocabularyLevel"] {
  if (grade < 6) return "elementary";
  if (grade < 9) return "middle";
  if (grade < 13) return "high school";
  if (grade < 16) return "college";
  return "graduate";
}

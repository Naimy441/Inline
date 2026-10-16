/** A word as the spell checker sees it: letters, then letters, digits, apostrophes and hyphens. */
export const WORD = /[\p{L}\p{M}][\p{L}\p{M}\p{N}'’-]*/gu;

/** Dictionary words compare without case and with plain apostrophes. */
export function normalizeWord(word: string) {
  return word.replace(/’/g, "'").replace(/^['-]+|['-]+$/g, "").toLowerCase();
}

/**
 * A Hunspell-style checker. `correct` returns null when the verdict isn't
 * known yet (the editor asks the server, then asks again).
 */
export type SpellChecker = { correct(word: string): boolean | null };

/**
 * Whether the dictionary accepts `word`: the word itself, the same word with
 * straight apostrophes, or the word it is a possessive of ("Zola's").
 * Null means a verdict is still outstanding, so the word is not underlined yet.
 */
export function spellingAccepts(word: string, check: SpellChecker): boolean | null {
  const first = check.correct(word);
  if (first === true) return true;
  if (first === null) return null;
  const plain = word.replace(/’/g, "'");
  if (plain !== word) {
    const second = check.correct(plain);
    if (second === true) return true;
    if (second === null) return null;
  }
  const base = plain.replace(/'s$/i, "");
  if (base !== plain && base.length > 0) {
    const stem = check.correct(base);
    if (stem === true) return true;
    if (stem === null) return null;
  }
  return false;
}

export type MisspelledSpan = { word: string; from: number; to: number };

/**
 * Misspelled words in a block of prose, with offsets into `text`.
 * URLs, emails, file names, numbers, acronyms and the user's dictionary are skipped.
 * The same scan feeds the editor's underlines and Claude's check_spelling.
 */
export function misspelledSpans(text: string, dictionary: ReadonlySet<string>, check: SpellChecker): MisspelledSpan[] {
  const out: MisspelledSpan[] = [];
  WORD.lastIndex = 0;
  for (const match of text.matchAll(WORD)) {
    const start = match.index ?? 0;
    let tokenStart = start;
    while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1]!)) tokenStart -= 1;
    let tokenEnd = start + match[0].length;
    while (tokenEnd < text.length && !/\s/.test(text[tokenEnd]!)) tokenEnd += 1;
    const token = text.slice(tokenStart, tokenEnd);
    if (/:\/\/|^www\.|@|\w\.\w/.test(token)) continue;
    const whole = normalizeWord(match[0]);
    if (whole && (dictionary.has(whole) || dictionary.has(whole.replace(/'s$/, "")))) continue;
    let offset = start;
    for (const part of match[0].split("-")) {
      const word = part.replace(/['’]+$/, "");
      const at = offset;
      offset += part.length + 1;
      if (word.length < 2 || /\d/.test(word) || word === word.toUpperCase()) continue;
      const normalized = normalizeWord(word);
      if (!normalized || dictionary.has(normalized) || dictionary.has(normalized.replace(/'s$/, ""))) continue;
      if (spellingAccepts(word, check) !== false) continue;
      out.push({ word, from: at, to: at + word.length });
    }
  }
  return out;
}

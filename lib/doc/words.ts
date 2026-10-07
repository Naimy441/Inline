/** A word as the spell checker sees it: letters, then letters, digits, apostrophes and hyphens. */
export const WORD = /[\p{L}\p{M}][\p{L}\p{M}\p{N}'’-]*/gu;

/** Dictionary words compare without case and with plain apostrophes. */
export function normalizeWord(word: string) {
  return word.replace(/’/g, "'").replace(/^['-]+|['-]+$/g, "").toLowerCase();
}

"use client";

import { post } from "@/lib/client/api";
import type { SpellChecker } from "@/lib/doc/words";

const FLUSH_MS = 80;
const BATCH = 2000;

/**
 * Spell checker for the open editor. Words are asked of the server's Hunspell
 * dictionary and cached. `correct` returns null until that answer arrives, so
 * a word is not underlined on a guess.
 * Raw verdicts only: possessive folding happens in misspelledSpans.
 */
export function remoteSpeller(onChange: () => void): SpellChecker {
  const known = new Map<string, boolean>();
  const waiting = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending = false;

  const flush = () => {
    timer = null;
    if (sending || !waiting.size) return;
    const words = [...waiting].slice(0, BATCH);
    for (const word of words) waiting.delete(word);
    sending = true;
    void post<{ incorrect: string[] }>("/api/spellcheck", { words })
      .then(({ incorrect }) => {
        const bad = new Set(incorrect);
        let changed = false;
        for (const word of words) {
          const verdict = !bad.has(word);
          if (known.get(word) !== verdict) {
            known.set(word, verdict);
            changed = true;
          }
        }
        if (changed) onChange();
      })
      .catch(() => {
        for (const word of words) if (!known.has(word)) waiting.add(word);
      })
      .finally(() => {
        sending = false;
        if (waiting.size) schedule();
      });
  };

  const schedule = () => {
    if (sending) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, FLUSH_MS);
  };

  // Load the dictionary as the document opens, before the first word is checked.
  void post<{ incorrect: string[] }>("/api/spellcheck", { words: ["hello"] })
    .then(({ incorrect }) => {
      const verdict = !incorrect.includes("hello");
      if (known.get("hello") !== verdict) known.set("hello", verdict);
    })
    .catch(() => undefined);

  return {
    correct(word: string) {
      if (word.length > 100) return true;
      const verdict = known.get(word);
      if (verdict !== undefined) return verdict;
      waiting.add(word);
      if (waiting.size >= BATCH) {
        if (timer) clearTimeout(timer);
        timer = null;
        flush();
      } else schedule();
      return null;
    },
  };
}

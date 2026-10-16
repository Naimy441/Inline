import { normalizeWord } from "@/lib/doc/words";

/**
 * Definitions and synonyms for the right-click dictionary, from Datamuse
 * (Wiktionary-backed). The editor's own word list is a different thing: it
 * only decides which words stay un-underlined.
 */

export type DictionaryMeaning = { partOfSpeech: string; definitions: string[] };

export type DictionaryEntry = {
  word: string;
  meanings: DictionaryMeaning[];
  synonyms: string[];
};

type LexiconHit = { word: string; defs?: string[] };

const PARTS: Record<string, string> = {
  n: "noun",
  v: "verb",
  adj: "adjective",
  adv: "adverb",
  pron: "pronoun",
  prep: "preposition",
  conj: "conjunction",
  interj: "interjection",
  int: "interjection",
  aux: "verb",
  art: "article",
  num: "number",
};

const cache = new Map<string, DictionaryEntry | null>();

export function clearLookupCache() {
  cache.clear();
}

/** Keep a replacement's letters in the same case as the word it replaces. */
export function matchCase(source: string, replacement: string) {
  const letters = source.replace(/[^\p{L}\p{M}]/gu, "");
  if (letters && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return replacement.toLocaleUpperCase();
  const head = source.trim().charAt(0);
  if (head && head === head.toLocaleUpperCase() && head !== head.toLocaleLowerCase() && source.slice(1) === source.slice(1).toLocaleLowerCase()) {
    return replacement.charAt(0).toLocaleUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function remember(key: string, value: DictionaryEntry | null) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > 400) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
}

/** The form to look up: lower case, and without a trailing possessive. */
export function lookupKey(raw: string) {
  const word = normalizeWord(raw);
  if (!word || word.length > 40 || !/^[\p{L}\p{M}][\p{L}\p{M}\p{N}'-]*$/u.test(word)) return null;
  return word.endsWith("'s") && word.length > 3 ? word.slice(0, -2) : word;
}

function partName(tag: string) {
  return PARTS[tag.toLowerCase()] ?? tag;
}

/** Group Datamuse hits into one dictionary card. Near-spellings are ignored. */
export function entryFromLexicon(word: string, definitions: LexiconHit[], synonyms: LexiconHit[]): DictionaryEntry | null {
  const exact = definitions.find((hit) => hit.word.toLowerCase() === word);
  const meanings: DictionaryMeaning[] = [];
  for (const line of exact?.defs ?? []) {
    const split = line.indexOf("\t");
    if (split <= 0) continue;
    const part = partName(line.slice(0, split).trim());
    const text = line.slice(split + 1).replace(/\s+/g, " ").trim();
    if (!text) continue;
    let group = meanings.find((item) => item.partOfSpeech === part);
    if (!group) {
      if (meanings.length >= 4) continue;
      group = { partOfSpeech: part, definitions: [] };
      meanings.push(group);
    }
    if (group.definitions.length >= 3 || group.definitions.includes(text)) continue;
    group.definitions.push(text);
  }
  const seen = new Set<string>([word]);
  const picked: string[] = [];
  for (const hit of synonyms) {
    const synonym = hit.word.trim();
    const key = synonym.toLowerCase();
    if (!synonym || synonym.length > 32 || seen.has(key) || /\s/.test(synonym)) continue;
    seen.add(key);
    picked.push(synonym);
    if (picked.length >= 12) break;
  }
  if (!meanings.length && !picked.length) return null;
  return { word, meanings, synonyms: picked };
}

function asHits(body: unknown): LexiconHit[] {
  if (!Array.isArray(body)) throw new Error("Dictionary lookup returned an unexpected response.");
  return body.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as { word?: unknown; defs?: unknown };
    if (typeof record.word !== "string") return [];
    const defs = Array.isArray(record.defs) ? record.defs.filter((line): line is string => typeof line === "string") : undefined;
    return [{ word: record.word, defs }];
  });
}

async function datamuse(fetchImpl: typeof fetch, params: Record<string, string>) {
  const url = new URL("https://api.datamuse.com/words");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Dictionary lookup failed (${response.status}).`);
  return asHits(await response.json());
}

/** Definitions and synonyms, or null when the word isn't in the dictionary. Throws when the lookup itself fails. */
export async function lookupWord(raw: string, fetchImpl: typeof fetch = fetch): Promise<DictionaryEntry | null> {
  const word = lookupKey(raw);
  if (!word) return null;
  if (cache.has(word)) return cache.get(word) ?? null;
  const [definitions, synonyms] = await Promise.all([
    datamuse(fetchImpl, { sp: word, md: "d", max: "8" }),
    datamuse(fetchImpl, { rel_syn: word, max: "12" }).catch(() => [] as LexiconHit[]),
  ]);
  const entry = entryFromLexicon(word, definitions, synonyms);
  remember(word, entry);
  return entry;
}

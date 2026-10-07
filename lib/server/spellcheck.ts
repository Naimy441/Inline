import type { Node as PMNode } from "prosemirror-model";
import { textblockLines } from "@/lib/doc/editing";
import { serializeDoc } from "@/lib/doc/markdown";
import { normalizeWord, WORD } from "@/lib/doc/words";

/**
 * Spelling for Claude's check_spelling tool: a Hunspell English dictionary
 * (nspell + dictionary-en), run over the document's text the way the editor's
 * red underlines are, minus code, equations and the user's own dictionary.
 */

export type Speller = { correct(word: string): boolean; suggest(word: string): string[] };

let loading: Promise<Speller> | null = null;

export function speller(): Promise<Speller> {
  loading ??= (async () => {
    const [{ default: nspell }, { default: dictionary }] = await Promise.all([import("nspell"), import("dictionary-en")]);
    return nspell({ aff: Buffer.from(dictionary.aff), dic: Buffer.from(dictionary.dic) }) as Speller;
  })().catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

export type Misspelling = { word: string; line: number; from: number; to: number; context: string };

/** Marks whose text is not prose: not spell-checked. */
const SKIP_MARKS = new Set(["code", "math"]);

function isCorrect(word: string, check: Speller) {
  if (check.correct(word)) return true;
  const plain = word.replace(/’/g, "'");
  if (plain !== word && check.correct(plain)) return true;
  // Possessives of names and other words the dictionary knows ("Zola's").
  const base = plain.replace(/'s$/i, "");
  return base !== plain && base.length > 0 && check.correct(base);
}

/** Words the dictionary doesn't know, in document order, with their line in read_document's numbering. */
export function findMisspellings(doc: PMNode, check: Speller, dictionary: ReadonlySet<string>, lines?: { from: number; to: number }): Misspelling[] {
  const out: Misspelling[] = [];
  for (const entry of textblockLines(serializeDoc(doc))) {
    if (lines && (entry.endLine < lines.from || entry.startLine > lines.to)) continue;
    const node = entry.node;
    if (node.type.spec.code) continue;
    // The block's text, with code and equations blanked out so offsets still line up.
    let text = "";
    node.forEach((child) => {
      if (child.isText && !child.marks.some((mark) => SKIP_MARKS.has(mark.type.name))) text += child.text;
      else text += " ".repeat(child.isText ? child.text!.length : child.nodeSize);
    });
    for (const match of text.matchAll(WORD)) {
      const start = match.index!;
      // The whole run of non-space characters: URLs, emails and file names aren't words.
      let tokenStart = start;
      while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1]!)) tokenStart -= 1;
      let tokenEnd = start + match[0].length;
      while (tokenEnd < text.length && !/\s/.test(text[tokenEnd]!)) tokenEnd += 1;
      const token = text.slice(tokenStart, tokenEnd);
      if (/:\/\/|^www\.|@|\w\.\w/.test(token)) continue;
      let offset = start;
      for (const part of match[0].split("-")) {
        const word = part.replace(/['’]+$/, "");
        const at = offset;
        offset += part.length + 1;
        if (word.length < 2 || /\d/.test(word) || word === word.toUpperCase()) continue;
        if (dictionary.has(normalizeWord(word)) || isCorrect(word, check)) continue;
        const from = entry.pos + 1 + at;
        const contextStart = Math.max(0, at - 30);
        const contextEnd = Math.min(text.length, at + word.length + 30);
        out.push({
          word,
          line: entry.startLine,
          from,
          to: from + word.length,
          context: `${contextStart > 0 ? "…" : ""}${text.slice(contextStart, contextEnd).replace(/\s+/g, " ").trim()}${contextEnd < text.length ? "…" : ""}`,
        });
      }
    }
  }
  return out;
}

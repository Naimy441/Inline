import type { Node as PMNode } from "prosemirror-model";
import { textblockLines } from "@/lib/doc/editing";
import { serializeDoc } from "@/lib/doc/markdown";
import { misspelledSpans } from "@/lib/doc/words";

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

/** Words the dictionary doesn't know, in document order, with their line in read_document's numbering. */
export function findMisspellings(doc: PMNode, check: Speller, dictionary: ReadonlySet<string>, lines?: { from: number; to: number }): Misspelling[] {
  const out: Misspelling[] = [];
  for (const entry of textblockLines(serializeDoc(doc))) {
    if (lines && (entry.endLine < lines.from || entry.startLine > lines.to)) continue;
    const node = entry.node;
    if (node.type.spec.code) continue;
    // The block's text, with code and equations blanked out so offsets still line up.
    // Kept in step with the editor's underline pass (lib/editor/spelling.ts).
    let text = "";
    node.forEach((child) => {
      if (child.isText && !child.marks.some((mark) => SKIP_MARKS.has(mark.type.name))) text += child.text;
      else text += " ".repeat(child.isText ? child.text!.length : child.nodeSize);
    });
    for (const hit of misspelledSpans(text, dictionary, check)) {
      const contextStart = Math.max(0, hit.from - 30);
      const contextEnd = Math.min(text.length, hit.to + 30);
      out.push({
        word: hit.word,
        line: entry.startLine,
        from: entry.pos + 1 + hit.from,
        to: entry.pos + 1 + hit.to,
        context: `${contextStart > 0 ? "…" : ""}${text.slice(contextStart, contextEnd).replace(/\s+/g, " ").trim()}${contextEnd < text.length ? "…" : ""}`,
      });
    }
  }
  return out;
}

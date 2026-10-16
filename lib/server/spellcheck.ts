import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Node as PMNode } from "prosemirror-model";
import { textblockLines } from "@/lib/doc/editing";
import { serializeDoc } from "@/lib/doc/markdown";
import { misspelledSpans } from "@/lib/doc/words";

/**
 * Spelling for Claude's check_spelling tool, run over the document's text the
 * way the editor's underlines are, minus code, equations, text Claude
 * inserted, and the user's own dictionary.
 *
 * The word list is the maintained en_US Hunspell dictionary (lib/server/hunspell).
 * dictionary-en is SCOWL size 60 from 2020: `subspace` is listed with no
 * affix flags so the plural `subspaces` is rejected, `shift` can form
 * `shifted` but not `unshifted` (it lacks the un- flag), and `wireframe` is
 * absent because compounds are only generated for ordinals. Those are ordinary
 * words missing from that list, not special cases.
 */

export type Speller = { correct(word: string): boolean; suggest(word: string): string[] };

let loading: Promise<Speller> | null = null;

/** Affix rules and word list, read from the repo so dev, tests and the server share one dictionary. */
export function englishDictionary(): { aff: Buffer; dic: Buffer } {
  const dir = join(process.cwd(), "lib/server/hunspell");
  return { aff: readFileSync(join(dir, "en_US.aff")), dic: readFileSync(join(dir, "en_US.dic")) };
}

export function speller(): Promise<Speller> {
  loading ??= (async () => {
    const { default: nspell } = await import("nspell");
    return nspell(englishDictionary()) as Speller;
  })().catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

export type Misspelling = { word: string; line: number; from: number; to: number; context: string };

/** Marks whose text is not spell-checked: code, equations, and text an agent inserted. */
const SKIP_MARKS = new Set(["code", "math", "agent"]);

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

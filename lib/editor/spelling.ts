import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { normalizeWord, WORD } from "@/lib/doc/words";

/**
 * Words the user added to their dictionary: every occurrence is wrapped with
 * spellcheck="false", so the browser stops underlining it. (Browsers don't let
 * a page add to their own dictionary.)
 */

const spellingKey = new PluginKey<SpellingState>("spelling");
type SpellingState = { words: ReadonlySet<string>; decorations: DecorationSet };

export { normalizeWord };

function build(doc: PMNode, words: ReadonlySet<string>) {
  if (!words.size) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    for (const match of node.text.matchAll(WORD)) {
      const word = normalizeWord(match[0]);
      // A dictionary name covers its possessive too ("Quillith's").
      if (words.has(word) || words.has(word.replace(/'s$/, ""))) decorations.push(Decoration.inline(pos + match.index, pos + match.index + match[0].length, { spellcheck: "false" }));
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

export function spellingPlugin(initial: Iterable<string>) {
  return new Plugin<SpellingState>({
    key: spellingKey,
    state: {
      init: (_config, state) => {
        const words = new Set(initial);
        return { words, decorations: build(state.doc, words) };
      },
      apply(tr, value, _old, state) {
        const words = tr.getMeta(spellingKey) as ReadonlySet<string> | undefined;
        if (words) return { words, decorations: build(state.doc, words) };
        return tr.docChanged && value.words.size ? { words: value.words, decorations: build(state.doc, value.words) } : value;
      },
    },
    props: {
      decorations: (state) => spellingKey.getState(state)?.decorations,
    },
  });
}

export function setDictionary(tr: Transaction, words: Iterable<string>) {
  return tr.setMeta(spellingKey, new Set(words));
}

/** The word at a document position, or null. */
export function wordAt(state: EditorState, pos: number): { from: number; to: number; text: string } | null {
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const start = $pos.start();
  const text = parent.textBetween(0, parent.content.size, "￼", "￼");
  const offset = pos - start;
  for (const match of text.matchAll(WORD)) {
    if (match.index <= offset && offset <= match.index + match[0].length) return { from: start + match.index, to: start + match.index + match[0].length, text: match[0] };
  }
  return null;
}

/** The word under the selection: a selected single word, or the word the cursor is in. */
export function selectedWord(view: EditorView) {
  const { from, to, empty } = view.state.selection;
  const word = wordAt(view.state, from);
  if (!word) return null;
  if (!empty && (word.from !== from || word.to !== to)) return null;
  return word;
}

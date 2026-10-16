import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { misspelledSpans, normalizeWord, WORD, type SpellChecker } from "@/lib/doc/words";

/**
 * Live spelling underlines.
 *
 * Misspellings get a red wavy line (class `spelling-error`) from the same
 * Hunspell dictionary Claude uses. The browser's own underlines are not
 * reliable here, so a misspelled span also sets spellcheck="false" and the
 * line is ours. Words the user added to their dictionary are wrapped with
 * spellcheck="false" and are not underlined. (Browsers don't let a page add
 * to their own dictionary.)
 *
 * The checker may answer `null` while a verdict is still loading. Those words
 * stay plain until the answer arrives, then the decorations are rebuilt.
 */

const spellingKey = new PluginKey<SpellingState>("spelling");
type SpellingState = { words: ReadonlySet<string>; enabled: boolean; check: SpellChecker | null; decorations: DecorationSet };
type SpellingMeta = { words?: ReadonlySet<string>; enabled?: boolean; check?: SpellChecker | null; refresh?: boolean };

const SKIP_MARKS = new Set(["code", "math"]);

export { normalizeWord };

export type SpellingPluginOptions = {
  /** Draw underlines. Off when the user hides spelling. */
  enabled?: boolean;
  /** When omitted, the editor view loads the shared Hunspell dictionary. */
  check?: SpellChecker | null;
};

function build(doc: PMNode, words: ReadonlySet<string>, enabled: boolean, check: SpellChecker | null) {
  const decorations: Decoration[] = [];
  if (words.size) {
    doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return true;
      WORD.lastIndex = 0;
      for (const match of node.text.matchAll(WORD)) {
        const word = normalizeWord(match[0]);
        // A dictionary name covers its possessive too ("Quillith's").
        if (words.has(word) || words.has(word.replace(/'s$/, ""))) {
          const from = pos + (match.index ?? 0);
          decorations.push(Decoration.inline(from, from + match[0].length, { spellcheck: "false" }, { spelling: "dictionary" }));
        }
      }
      return false;
    });
  }
  if (enabled && check) {
    doc.descendants((node, pos) => {
      if (node.type.spec.code) return false;
      if (!node.isTextblock) return true;
      // Code and equations are blanked so offsets still line up with the document.
      let text = "";
      node.forEach((child) => {
        if (child.isText && !child.marks.some((mark) => SKIP_MARKS.has(mark.type.name))) text += child.text;
        else text += " ".repeat(child.isText ? child.text!.length : child.nodeSize);
      });
      for (const hit of misspelledSpans(text, words, check)) {
        const from = pos + 1 + hit.from;
        decorations.push(Decoration.inline(from, from + (hit.to - hit.from), { class: "spelling-error", spellcheck: "false" }, { spelling: "spelling-error" }));
      }
      return false;
    });
  }
  if (!decorations.length) return DecorationSet.empty;
  decorations.sort((a, b) => a.from - b.from || a.to - b.to);
  return DecorationSet.create(doc, decorations);
}

export function spellingPlugin(initial: Iterable<string>, options: SpellingPluginOptions = {}) {
  const initialCheck = options.check ?? null;
  const initialEnabled = options.enabled ?? true;
  return new Plugin<SpellingState>({
    key: spellingKey,
    state: {
      init: (_config, state) => {
        const words = new Set(initial);
        return { words, enabled: initialEnabled, check: initialCheck, decorations: build(state.doc, words, initialEnabled, initialCheck) };
      },
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(spellingKey) as SpellingMeta | undefined;
        if (!meta && !tr.docChanged) return value;
        const words = meta?.words ?? value.words;
        const enabled = meta?.enabled ?? value.enabled;
        const check = meta && "check" in meta ? (meta.check ?? null) : value.check;
        if (!meta && !words.size && !check) return value;
        return { words, enabled, check, decorations: build(state.doc, words, enabled, check) };
      },
    },
    props: {
      decorations: (state) => spellingKey.getState(state)?.decorations,
    },
    view(editorView) {
      if (initialCheck || spellingKey.getState(editorView.state)?.check) return {};
      let dead = false;
      // The dictionary stays on the server (it reads Hunspell files from disk).
      // Verdicts come back as the user types and the underlines update in place.
      void import("@/lib/client/browserSpeller").then(
        ({ remoteSpeller }) => {
          if (dead) return;
          const current = spellingKey.getState(editorView.state);
          if (!current || current.check) return;
          const check = remoteSpeller(() => {
            if (dead || !editorView.dom.isConnected) return;
            editorView.dispatch(editorView.state.tr.setMeta(spellingKey, { refresh: true }).setMeta("addToHistory", false));
          });
          editorView.dispatch(editorView.state.tr.setMeta(spellingKey, { check }).setMeta("addToHistory", false));
        },
        () => undefined,
      );
      return {
        destroy() {
          dead = true;
        },
      };
    },
  });
}

export function setDictionary(tr: Transaction, words: Iterable<string>) {
  return tr.setMeta(spellingKey, { words: new Set(words) } satisfies SpellingMeta);
}

export function setSpellcheckEnabled(tr: Transaction, enabled: boolean) {
  return tr.setMeta(spellingKey, { enabled } satisfies SpellingMeta);
}

/** The word at a document position, or null. */
export function wordAt(state: EditorState, pos: number): { from: number; to: number; text: string } | null {
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const start = $pos.start();
  const text = parent.textBetween(0, parent.content.size, "￼", "￼");
  const offset = pos - start;
  WORD.lastIndex = 0;
  for (const match of text.matchAll(WORD)) {
    const index = match.index ?? 0;
    if (index <= offset && offset <= index + match[0].length) return { from: start + index, to: start + index + match[0].length, text: match[0] };
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

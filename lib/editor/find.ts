import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

/** Find and replace across the document, matching within each textblock. */

export type FindQuery = { text: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean };
export type FindMatch = { from: number; to: number };

type FindState = { query: FindQuery | null; matches: FindMatch[]; current: number };

export const findKey = new PluginKey<FindState>("find");

function buildPattern(query: FindQuery): RegExp | null {
  if (!query.text) return null;
  let source = query.regex ? query.text : query.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (query.wholeWord) source = `\\b${source}\\b`;
  try {
    return new RegExp(source, query.caseSensitive ? "gu" : "giu");
  } catch {
    return null;
  }
}

export function findMatches(doc: PMNode, query: FindQuery): FindMatch[] {
  const pattern = buildPattern(query);
  if (!pattern) return [];
  const matches: FindMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Map text offsets back to positions (inline atoms like hard breaks take one position).
    let text = "";
    const positions: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i += 1) {
          text += child.text![i];
          positions.push(pos + 1 + offset + i);
        }
      } else {
        text += "\n";
        positions.push(pos + 1 + offset);
      }
    });
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) && matches.length < 10_000) {
      if (!match[0].length) {
        pattern.lastIndex += 1;
        continue;
      }
      const start = positions[match.index]!;
      const end = positions[match.index + match[0].length - 1]! + 1;
      matches.push({ from: start, to: end });
    }
    return false;
  });
  return matches;
}

export function setFindQuery(tr: Transaction, query: FindQuery | null) {
  return tr.setMeta(findKey, { query });
}

export function setFindIndex(tr: Transaction, index: number) {
  return tr.setMeta(findKey, { current: index });
}

export function findPlugin() {
  return new Plugin<FindState>({
    key: findKey,
    state: {
      init: () => ({ query: null, matches: [], current: 0 }),
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(findKey) as Partial<FindState> | undefined;
        let next = value;
        if (meta && "query" in meta) {
          const query = meta.query ?? null;
          const matches = query ? findMatches(state.doc, query) : [];
          const head = state.selection.from;
          const index = Math.max(0, matches.findIndex((match) => match.from >= head));
          next = { query, matches, current: matches.length ? index : 0 };
        } else if (next.query && tr.docChanged) {
          const matches = findMatches(state.doc, next.query);
          next = { ...next, matches, current: Math.min(next.current, Math.max(0, matches.length - 1)) };
        }
        if (meta && typeof meta.current === "number") next = { ...next, current: meta.current };
        return next;
      },
    },
    props: {
      decorations(state) {
        const value = findKey.getState(state);
        if (!value?.matches.length) return DecorationSet.empty;
        return DecorationSet.create(
          state.doc,
          value.matches.map((match, index) => Decoration.inline(match.from, match.to, { class: index === value.current ? "find-match is-current" : "find-match" })),
        );
      },
    },
  });
}

export function findState(state: EditorState) {
  return findKey.getState(state) ?? { query: null, matches: [], current: 0 };
}

export function findStep(view: EditorView, direction: 1 | -1) {
  const value = findState(view.state);
  if (!value.matches.length) return;
  const index = (value.current + direction + value.matches.length) % value.matches.length;
  const match = value.matches[index]!;
  const tr = setFindIndex(view.state.tr, index).setSelection(TextSelection.create(view.state.doc, match.from, match.to)).scrollIntoView();
  view.dispatch(tr);
}

export function replaceCurrent(view: EditorView, replacement: string) {
  const value = findState(view.state);
  const match = value.matches[value.current];
  if (!match || !value.query) return;
  const text = expandReplacement(view.state.doc.textBetween(match.from, match.to), value.query, replacement);
  const tr = view.state.tr;
  if (text) tr.insertText(text, match.from, match.to);
  else tr.delete(match.from, match.to);
  view.dispatch(tr);
  // Advance to the match after the replaced one.
  const after = findState(view.state).matches.findIndex((item) => item.from >= match.from + text.length);
  if (after >= 0) view.dispatch(setFindIndex(view.state.tr, after));
}

export function replaceAll(view: EditorView, replacement: string) {
  const value = findState(view.state);
  if (!value.matches.length || !value.query) return 0;
  const tr = view.state.tr;
  for (const match of [...value.matches].reverse()) {
    const text = expandReplacement(view.state.doc.textBetween(match.from, match.to), value.query, replacement);
    if (text) tr.insertText(text, match.from, match.to);
    else tr.delete(match.from, match.to);
  }
  view.dispatch(tr);
  return value.matches.length;
}

function expandReplacement(matched: string, query: FindQuery, replacement: string) {
  if (!query.regex) return replacement;
  const pattern = buildPattern({ ...query, wholeWord: false });
  if (!pattern) return replacement;
  pattern.lastIndex = 0;
  return matched.replace(new RegExp(pattern.source, pattern.flags.replace("g", "")), replacement);
}

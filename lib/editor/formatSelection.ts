import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/** The phrase kept painted while the font menu or the font size field has focus. */
export type FormatRange = { from: number; to: number };

export const formatSelectionKey = new PluginKey<FormatRange | null>("formatSelection");

/**
 * A range read from the page replaces the one being held. An empty read does
 * not: focusing the font search or the size field collapses the DOM selection,
 * and the phrase that was selected is still the one to format.
 */
export function retainFormattingRange(pinned: FormatRange | null, read: { from: number; to: number } | null): FormatRange | null {
  if (read && read.to > read.from) return { from: read.from, to: read.to };
  if (pinned && pinned.to > pinned.from) return pinned;
  return null;
}

export function setFormatSelection(tr: Transaction, range: FormatRange | null) {
  return tr.setMeta(formatSelectionKey, range);
}

/** Inline highlights for a range that may cross paragraphs. One decoration cannot. */
export function formatSelectionDecorations(doc: PMNode, range: FormatRange | null): Decoration[] {
  if (!range) return [];
  const from = Math.max(0, range.from);
  const to = Math.min(doc.content.size, range.to);
  if (from >= to) return [];
  const decorations: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    if (start < end) decorations.push(Decoration.inline(start, end, { class: "format-selection" }));
  });
  return decorations;
}

export function formatSelectionPlugin() {
  return new Plugin<FormatRange | null>({
    key: formatSelectionKey,
    state: {
      init: () => null,
      apply(tr, value) {
        const meta = tr.getMeta(formatSelectionKey) as FormatRange | null | undefined;
        if (meta !== undefined) return meta && meta.to > meta.from ? meta : null;
        if (!value || !tr.docChanged) return value;
        const from = tr.mapping.map(value.from, 1);
        const to = tr.mapping.map(value.to, -1);
        return from < to ? { from, to } : null;
      },
    },
    props: {
      decorations(state) {
        const range = formatSelectionKey.getState(state);
        if (!range) return null;
        const decorations = formatSelectionDecorations(state.doc, range);
        return decorations.length ? DecorationSet.create(state.doc, decorations) : null;
      },
    },
  });
}

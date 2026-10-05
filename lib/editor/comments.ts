import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/**
 * Comment highlights. Anchors live in the document as `comment` marks; which
 * of them are open (and which one is active) comes from the comment list.
 */

type CommentsState = { open: Set<string>; active: string | null };

export const commentsKey = new PluginKey<CommentsState>("comments");

export function setCommentState(tr: Transaction, patch: Partial<{ open: string[]; active: string | null }>) {
  return tr.setMeta(commentsKey, patch);
}

/** Ranges of each comment's anchor in the current document. */
export function commentRanges(state: EditorState) {
  const ranges = new Map<string, { from: number; to: number }>();
  state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== "comment") continue;
      const id = mark.attrs.id as string;
      const existing = ranges.get(id);
      if (existing) {
        existing.from = Math.min(existing.from, pos);
        existing.to = Math.max(existing.to, pos + node.nodeSize);
      } else {
        ranges.set(id, { from: pos, to: pos + node.nodeSize });
      }
    }
    return false;
  });
  return ranges;
}

export function commentsPlugin(onActivate: (id: string | null) => void) {
  return new Plugin<CommentsState>({
    key: commentsKey,
    state: {
      init: () => ({ open: new Set(), active: null }),
      apply(tr, value) {
        const meta = tr.getMeta(commentsKey) as Partial<{ open: string[]; active: string | null }> | undefined;
        if (!meta) return value;
        return { open: meta.open ? new Set(meta.open) : value.open, active: meta.active !== undefined ? meta.active : value.active };
      },
    },
    props: {
      decorations(state) {
        const value = commentsKey.getState(state);
        if (!value || !value.open.size) return DecorationSet.empty;
        const decorations: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (!node.isText) return true;
          for (const mark of node.marks) {
            if (mark.type.name !== "comment" || !value.open.has(mark.attrs.id)) continue;
            const active = value.active === mark.attrs.id;
            decorations.push(Decoration.inline(pos, pos + node.nodeSize, { class: active ? "comment-hl is-active" : "comment-hl" }));
          }
          return false;
        });
        return DecorationSet.create(state.doc, decorations);
      },
      handleClick(view, pos) {
        const value = commentsKey.getState(view.state);
        if (!value?.open.size) return false;
        const $pos = view.state.doc.resolve(pos);
        const marks = [...$pos.marks(), ...($pos.nodeAfter?.marks ?? [])];
        const hit = marks.find((mark) => mark.type.name === "comment" && value.open.has(mark.attrs.id));
        onActivate(hit ? (hit.attrs.id as string) : null);
        return false;
      },
    },
  });
}

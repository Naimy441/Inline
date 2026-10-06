import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/**
 * Comment highlights. Anchors live in the document as `comment` marks; which
 * of them are open (and which one is active) comes from the comment list.
 */

type Range = { from: number; to: number };
/** `draft` is the text a comment is being written about, highlighted while the editor isn't focused. */
type CommentsState = { open: Set<string>; active: string | null; draft: Range | null };
type CommentsPatch = Partial<{ open: string[]; active: string | null; draft: Range | null }>;

export const commentsKey = new PluginKey<CommentsState>("comments");

export function setCommentState(tr: Transaction, patch: CommentsPatch) {
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

/** The range a comment is being drafted about, if any. */
export function commentDraft(state: EditorState) {
  return commentsKey.getState(state)?.draft ?? null;
}

export function commentsPlugin(onActivate: (id: string | null) => void) {
  return new Plugin<CommentsState>({
    key: commentsKey,
    state: {
      init: () => ({ open: new Set(), active: null, draft: null }),
      apply(tr, value) {
        const meta = tr.getMeta(commentsKey) as CommentsPatch | undefined;
        let draft = meta?.draft !== undefined ? meta.draft : value.draft;
        if (draft && tr.docChanged && meta?.draft === undefined) {
          const from = tr.mapping.map(draft.from, 1);
          const to = tr.mapping.map(draft.to, -1);
          draft = to > from ? { from, to } : null;
        }
        if (!meta) return draft === value.draft ? value : { ...value, draft };
        return { open: meta.open ? new Set(meta.open) : value.open, active: meta.active !== undefined ? meta.active : value.active, draft };
      },
    },
    props: {
      decorations(state) {
        const value = commentsKey.getState(state);
        if (!value || (!value.open.size && !value.draft)) return DecorationSet.empty;
        const decorations: Decoration[] = [];
        if (value.draft) decorations.push(Decoration.inline(value.draft.from, value.draft.to, { class: "comment-hl is-draft" }));
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

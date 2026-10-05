import { sendableSteps, getVersion } from "prosemirror-collab";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Mapping } from "prosemirror-transform";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { isUserSuggestion, type HunkJSON } from "@/lib/doc/review";

/**
 * Cursor-style review of Claude's edits. Hunks arrive from the server in
 * server-version coordinates; they're mapped through this editor's not yet
 * confirmed steps so the highlights stay put while the user types. Inserted
 * text is tinted, deleted text is shown struck through in place, and the
 * hunk under the cursor or pointer gets Keep / Undo controls.
 */

export type ReviewHandlers = {
  review: (action: "accept" | "reject", ids: string[]) => void;
};

type ReviewState = { hunks: HunkJSON[]; version: number; focused: string | null };

export const reviewKey = new PluginKey<ReviewState>("review");

type ReviewMeta = { hunks?: HunkJSON[]; version?: number; focused?: string | null };

export function setHunks(tr: Transaction, hunks: HunkJSON[], version: number) {
  return tr.setMeta(reviewKey, { hunks, version } satisfies ReviewMeta);
}

function unconfirmedMapping(state: EditorState) {
  const sendable = sendableSteps(state);
  const mapping = new Mapping();
  if (sendable) for (const step of sendable.steps) mapping.appendMap(step.getMap());
  return mapping;
}

export type MappedHunk = HunkJSON & { mappedFrom: number; mappedTo: number };

/** Hunks in this editor's current coordinates. */
export function mappedHunks(state: EditorState): MappedHunk[] {
  const review = reviewKey.getState(state);
  if (!review || !review.hunks.length) return [];
  // Hunks for a version this editor hasn't reached yet arrive with the steps that produce it.
  if (review.version !== getVersion(state)) return [];
  const mapping = unconfirmedMapping(state);
  const size = state.doc.content.size;
  return review.hunks.map((hunk) => {
    const from = Math.min(size, mapping.map(hunk.from, 1));
    const to = Math.max(from, Math.min(size, mapping.map(hunk.to, -1)));
    return { ...hunk, mappedFrom: from, mappedTo: to };
  });
}

function clipDeleted(text: string) {
  const flat = text.replace(/\n+/g, " ¶ ").trim();
  return flat.length > 400 ? `${flat.slice(0, 400)}…` : flat;
}

function controls(hunk: MappedHunk, handlers: ReviewHandlers) {
  const box = document.createElement("span");
  box.className = "review-controls";
  box.contentEditable = "false";
  box.setAttribute("data-hunk", hunk.id);
  const keep = document.createElement("button");
  keep.type = "button";
  keep.className = "review-btn review-keep";
  keep.title = "Keep this change (⌘⏎)";
  keep.textContent = "Keep";
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "review-btn review-undo";
  undo.title = "Undo this change (⌘⌫)";
  undo.textContent = "Undo";
  for (const [button, action] of [
    [keep, "accept"],
    [undo, "reject"],
  ] as const) {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handlers.review(action, [hunk.id]);
    });
  }
  box.append(keep, undo);
  return box;
}

function buildDecorations(state: EditorState, handlers: ReviewHandlers) {
  const hunks = mappedHunks(state);
  if (!hunks.length) return DecorationSet.empty;
  const review = reviewKey.getState(state)!;
  const decorations: Decoration[] = [];
  for (const hunk of hunks) {
    const focused = review.focused === hunk.id;
    const by = isUserSuggestion(hunk) ? " is-suggestion" : "";
    const formatOnly = hunk.deletedText === hunk.insertedText && hunk.mappedTo > hunk.mappedFrom;
    if (hunk.mappedTo > hunk.mappedFrom) {
      decorations.push(
        Decoration.inline(hunk.mappedFrom, hunk.mappedTo, {
          class: `${formatOnly ? "review-format" : "review-insert"}${by}${focused ? " is-focused" : ""}`,
          "data-hunk": hunk.id,
        }),
      );
      // Whole blocks that were inserted get a gutter bar.
      state.doc.nodesBetween(hunk.mappedFrom, hunk.mappedTo, (node, pos) => {
        if (node.isTextblock && pos >= hunk.mappedFrom - 1 && pos + node.nodeSize <= hunk.mappedTo + 1) {
          decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: `review-block${by}` }));
        }
        return !node.isTextblock;
      });
    }
    if (hunk.deletedText && !formatOnly) {
      decorations.push(
        Decoration.widget(
          hunk.mappedFrom,
          () => {
            const span = document.createElement("span");
            span.className = `review-delete${by}${focused ? " is-focused" : ""}`;
            span.setAttribute("data-hunk", hunk.id);
            span.textContent = clipDeleted(hunk.deletedText);
            return span;
          },
          { side: -1, key: `del-${hunk.id}-${focused}`, ignoreSelection: true, marks: [] },
        ),
      );
    }
    if (focused) {
      decorations.push(Decoration.widget(hunk.mappedTo, () => controls(hunk, handlers), { side: 1, key: `ctl-${hunk.id}`, ignoreSelection: true, stopEvent: () => true }));
    }
  }
  return DecorationSet.create(state.doc, decorations);
}

function hunkAt(state: EditorState, pos: number) {
  return mappedHunks(state).find((hunk) => pos >= hunk.mappedFrom && pos <= hunk.mappedTo) ?? null;
}

export function reviewPlugin(handlers: ReviewHandlers) {
  return new Plugin<ReviewState>({
    key: reviewKey,
    state: {
      init: () => ({ hunks: [], version: 0, focused: null }),
      apply(tr, value, _old, newState) {
        const meta = tr.getMeta(reviewKey) as ReviewMeta | undefined;
        let next = value;
        if (meta) next = { ...next, ...meta };
        if (next.hunks.length && (tr.selectionSet || tr.docChanged) && meta?.focused === undefined) {
          const head = newState.selection.head;
          const hit = hunkAt(newState, head);
          // While someone types a suggestion, its Keep/Undo controls would chase the
          // cursor; they appear once the cursor moves (or on hover) instead.
          const typing = hit && tr.docChanged && isUserSuggestion(hit);
          if (hit && !typing) next = { ...next, focused: hit.id };
          else if (typing && next.focused === hit.id) next = { ...next, focused: null };
          else if (next.focused && !next.hunks.some((hunk) => hunk.id === next.focused)) next = { ...next, focused: null };
        }
        return next;
      },
    },
    props: {
      decorations: (state) => buildDecorations(state, handlers),
      handleDOMEvents: {
        mouseover(view, event) {
          const target = (event.target as HTMLElement | null)?.closest?.("[data-hunk]");
          const id = target?.getAttribute("data-hunk") ?? null;
          const current = reviewKey.getState(view.state)?.focused ?? null;
          if (id && id !== current) view.dispatch(view.state.tr.setMeta(reviewKey, { focused: id } satisfies ReviewMeta));
          return false;
        },
      },
    },
  });
}

/** Keep or undo the hunk under the cursor. */
export function reviewHunkAtCursor(view: EditorView, action: "accept" | "reject", handlers: ReviewHandlers) {
  const hit = hunkAt(view.state, view.state.selection.head) ?? (() => {
    const focused = reviewKey.getState(view.state)?.focused;
    return focused ? mappedHunks(view.state).find((hunk) => hunk.id === focused) ?? null : null;
  })();
  if (!hit) return false;
  handlers.review(action, [hit.id]);
  return true;
}

/** Move the selection to the next (or previous) hunk and return it. */
export function gotoHunk(view: EditorView, direction: 1 | -1) {
  const hunks = mappedHunks(view.state).sort((a, b) => a.mappedFrom - b.mappedFrom);
  if (!hunks.length) return null;
  const head = view.state.selection.head;
  const target =
    direction === 1
      ? hunks.find((hunk) => hunk.mappedFrom > head) ?? hunks[0]!
      : [...hunks].reverse().find((hunk) => hunk.mappedTo < head) ?? hunks[hunks.length - 1]!;
  return target;
}

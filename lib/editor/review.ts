import { sendableSteps, getVersion } from "prosemirror-collab";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Mapping, type Step } from "prosemirror-transform";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { isUserSuggestion, type HunkJSON } from "@/lib/doc/review";
import { formatShortcut, isApple } from "@/lib/client/platform";

/**
 * Cursor-style review of Claude's edits. Hunks arrive from the server in
 * server-version coordinates; they're mapped through this editor's not yet
 * confirmed steps so the highlights stay put while the user types. Inserted
 * text is tinted, deleted text is shown struck through in place, and the
 * hunk under the cursor or pointer gets Keep / Undo controls in the margin.
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

/**
 * Carry the pending changes through steps that arrived without a new list
 * (the server leaves it out when plain mapping gives the same result), the
 * same way the server maps them (lib/doc/review.ts mapHunks).
 */
export function mapHunksThrough(tr: Transaction, state: EditorState, steps: readonly Step[], fromVersion: number, toVersion: number) {
  const review = reviewKey.getState(state);
  if (!review || !review.hunks.length || review.version !== fromVersion) return tr;
  const mapping = new Mapping(steps.map((step) => step.getMap()));
  const hunks = review.hunks.map((hunk) => {
    const from = mapping.map(hunk.from, 1);
    return { ...hunk, from, to: Math.max(from, mapping.map(hunk.to, -1)) };
  });
  return setHunks(tr, hunks, toVersion);
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
  // Keep surrounding spaces: they separate the struck-out words from the text around them.
  const flat = text.replace(/\n+/g, " ¶ ").replace(/^ ¶ | ¶ $/g, " ");
  return flat.length > 400 ? `${flat.slice(0, 400)}…` : flat;
}

function buildDecorations(state: EditorState) {
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
  }
  return DecorationSet.create(state.doc, decorations);
}

function hunkAt(state: EditorState, pos: number) {
  return mappedHunks(state).find((hunk) => pos >= hunk.mappedFrom && pos <= hunk.mappedTo) ?? null;
}

/**
 * The page margins around the text: a bar in the left margin beside each
 * whole block Claude inserted, and the Keep / Undo buttons of the focused
 * change in the right margin. They live outside the editable text, so they
 * never move it, and a bar stops where a page ends and starts again on the next.
 */
class MarginLayer {
  private readonly layer: HTMLDivElement;
  private readonly actions: HTMLDivElement;
  private frame = 0;
  private shown: string | null = null;
  private readonly observer: ResizeObserver | null;

  constructor(
    private view: EditorView,
    private readonly handlers: ReviewHandlers,
  ) {
    this.layer = document.createElement("div");
    this.layer.className = "review-layer";
    this.layer.setAttribute("aria-hidden", "true");
    this.actions = document.createElement("div");
    this.actions.className = "review-controls";
    const apple = isApple();
    for (const [label, action, tip] of [
      ["Keep", "accept", `Keep this change  ${formatShortcut("⌘⇧⏎", apple)}`],
      ["Undo", "reject", `Undo this change  ${formatShortcut("⌘⇧⌫", apple)}`],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.tabIndex = -1;
      button.className = `review-btn review-${action === "accept" ? "keep" : "undo"}`;
      button.textContent = label;
      button.setAttribute("data-tip", tip);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", (event) => {
        event.preventDefault();
        if (this.shown) this.handlers.review(action, [this.shown]);
      });
      this.actions.append(button);
    }
    this.observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.schedule()) : null;
    this.observer?.observe(view.dom);
    this.attach();
    this.schedule();
  }

  private attach() {
    const host = this.view.dom.parentElement;
    if (host && this.layer.parentElement !== host) host.append(this.layer);
  }

  update(view: EditorView) {
    this.view = view;
    this.schedule();
  }

  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw() {
    this.attach();
    const root = this.view.dom as HTMLElement;
    const review = reviewKey.getState(this.view.state);
    if (!review?.hunks.length || !root.isConnected || !root.offsetWidth) {
      this.layer.replaceChildren();
      this.shown = null;
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const scale = rootRect.width / root.offsetWidth || 1;
    const local = (y: number) => (y - rootRect.top) / scale;
    const parts: HTMLElement[] = [];

    // A block's bar, split around the page breaks (spacers) inside it.
    for (const block of Array.from(root.querySelectorAll<HTMLElement>(".review-block"))) {
      const box = block.getBoundingClientRect();
      const left = (box.left - rootRect.left) / scale;
      let top = local(box.top);
      const segments: Array<[number, number]> = [];
      for (const gap of Array.from(block.querySelectorAll<HTMLElement>(".page-gap"))) {
        const rect = gap.getBoundingClientRect();
        segments.push([top, local(rect.top)]);
        top = local(rect.bottom);
      }
      segments.push([top, local(box.bottom)]);
      for (const [from, to] of segments) {
        if (to - from < 1) continue;
        const bar = document.createElement("div");
        bar.className = `review-gutter${block.classList.contains("is-suggestion") ? " is-suggestion" : ""}`;
        bar.style.cssText = `top:${from}px;height:${to - from}px;left:${left - 14}px`;
        parts.push(bar);
      }
    }

    // Keep / Undo beside the first line of the focused change.
    const focused = review.focused ? mappedHunks(this.view.state).find((hunk) => hunk.id === review.focused) : undefined;
    this.shown = focused?.id ?? null;
    if (focused) {
      const first = root.querySelector<HTMLElement>(`[data-hunk="${CSS.escape(focused.id)}"]`);
      let lineTop: number | null = null;
      let lineHeight = 0;
      const rect = first?.getClientRects()[0];
      if (rect) {
        lineTop = local(rect.top);
        lineHeight = rect.height / scale;
      } else {
        try {
          const coords = this.view.coordsAtPos(focused.mappedFrom, 1);
          lineTop = local(coords.top);
          lineHeight = (coords.bottom - coords.top) / scale;
        } catch {
          lineTop = null;
        }
      }
      if (lineTop != null) {
        this.actions.style.setProperty("--line-top", `${lineTop}px`);
        this.actions.style.setProperty("--line-height", `${lineHeight}px`);
        parts.push(this.actions);
      }
    }
    this.layer.replaceChildren(...parts);
  }

  destroy() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    this.layer.remove();
  }
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
    view: (view) => new MarginLayer(view, handlers),
    props: {
      decorations: (state) => buildDecorations(state),
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
export function gotoHunk(view: EditorView, direction: 1 | -1, only?: readonly string[]) {
  const hunks = mappedHunks(view.state)
    .filter((hunk) => !only || only.includes(hunk.id))
    .sort((a, b) => a.mappedFrom - b.mappedFrom);
  if (!hunks.length) return null;
  const head = view.state.selection.head;
  const target =
    direction === 1
      ? hunks.find((hunk) => hunk.mappedFrom > head) ?? hunks[0]!
      : [...hunks].reverse().find((hunk) => hunk.mappedTo < head) ?? hunks[hunks.length - 1]!;
  return target;
}

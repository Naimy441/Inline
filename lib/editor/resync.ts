import { sendableSteps } from "prosemirror-collab";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";
import type { Step } from "prosemirror-transform";

/**
 * Keeping local typing when the editor has to reload the server's copy of a
 * document (a missed event, a rejected step, a server restart).
 */

export type LocalEdits = { steps: Step[]; base: PMNode | null; current: PMNode };

/** The edits not yet confirmed by the server: their steps, the document they were typed against, and the result. */
export function unconfirmedEdits(state: EditorState): LocalEdits | null {
  const sendable = sendableSteps(state);
  if (!sendable || !sendable.steps.length) return null;
  const first = sendable.steps[0]!;
  const origin = sendable.origins[0]!;
  const index = origin.steps.indexOf(first);
  // After a rebase the first step is no longer the one its transaction typed, so its base is unknown.
  const base = index >= 0 ? (origin.docs[index] ?? null) : null;
  return { steps: [...sendable.steps], base, current: state.doc };
}

/**
 * Replay local edits on a fresh server state. They replay only when the server
 * still has the document they were typed against; otherwise the local result is
 * returned as `unmerged` so the user can recover it, unless the server already
 * has exactly that text.
 */
export function rebaseLocalEdits(fresh: EditorState, local: LocalEdits | null): { state: EditorState; unmerged: { doc: unknown; steps: number } | null } {
  if (!local) return { state: fresh, unmerged: null };
  if (local.base?.eq(fresh.doc)) {
    const tr = fresh.tr;
    if (local.steps.every((step) => !tr.maybeStep(step).failed)) return { state: fresh.apply(tr), unmerged: null };
  }
  if (local.current.eq(fresh.doc)) return { state: fresh, unmerged: null };
  return { state: fresh, unmerged: { doc: local.current.toJSON(), steps: local.steps.length } };
}

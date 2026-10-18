import { getVersion, sendableSteps } from "prosemirror-collab";
import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/** Shows where Claude is working: a soft highlight over the range and a labelled caret. */

export type Presence = { status: "reading" | "editing" | "thinking" | "idle"; label: string; range?: { from: number; to: number }; version: number } | null;

export const presenceKey = new PluginKey<Presence>("presence");

export function setPresence(tr: Transaction, presence: Presence) {
  return tr.setMeta(presenceKey, { presence });
}

function decorations(state: EditorState) {
  const presence = presenceKey.getState(state);
  if (!presence?.range || presence.status === "idle") return DecorationSet.empty;
  // Server positions are valid for the version they were recorded at. The editor
  // can be a step behind (spacing landed on the server, the page still has the
  // words) while those positions still sit in this document: draw them. A range
  // past the end belongs to a change that is not here yet. A version this editor
  // has already passed is stale, and a local edit may have moved the words.
  const size = state.doc.content.size;
  const behind = presence.version > getVersion(state);
  if (presence.version !== getVersion(state) && (!behind || presence.range.from > size || presence.range.to > size)) return DecorationSet.empty;
  let { from, to } = presence.range;
  const sendable = sendableSteps(state);
  if (sendable) {
    for (const step of sendable.steps) {
      const map = step.getMap();
      from = map.map(from, -1);
      to = map.map(to, 1);
    }
  }
  from = Math.max(0, Math.min(size, from));
  to = Math.max(from, Math.min(size, to));
  const items: Decoration[] = [];
  if (to > from) items.push(Decoration.inline(from, to, { class: `agent-range agent-${presence.status}` }));
  items.push(
    Decoration.widget(
      to,
      () => {
        const caret = document.createElement("span");
        caret.className = `agent-caret agent-${presence.status}`;
        caret.contentEditable = "false";
        const flag = document.createElement("span");
        flag.className = "agent-caret-flag";
        caret.append(flag);
        return caret;
      },
      { side: 1, key: `agent-caret-${presence.status}`, ignoreSelection: true, marks: [] },
    ),
  );
  return DecorationSet.create(state.doc, items);
}

export function presencePlugin() {
  return new Plugin<Presence>({
    key: presenceKey,
    state: {
      init: () => null,
      apply(tr, value) {
        const meta = tr.getMeta(presenceKey) as { presence: Presence } | undefined;
        return meta ? meta.presence : value;
      },
    },
    props: { decorations },
  });
}

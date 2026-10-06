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
  // Server positions are valid for the version they were recorded at; map through local unconfirmed steps.
  if (presence.version !== getVersion(state)) return DecorationSet.empty;
  let { from, to } = presence.range;
  const sendable = sendableSteps(state);
  if (sendable) {
    for (const step of sendable.steps) {
      const map = step.getMap();
      from = map.map(from, -1);
      to = map.map(to, 1);
    }
  }
  const size = state.doc.content.size;
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

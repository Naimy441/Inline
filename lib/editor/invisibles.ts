import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/**
 * View > Show non-printing characters: a pilcrow at the end of every
 * paragraph, a return arrow at line breaks and a centered dot in each space.
 * Purely visual; the marks are hidden when printing.
 */

type InvisiblesState = { on: boolean; decorations: DecorationSet };

const invisiblesKey = new PluginKey<InvisiblesState>("invisibles");

export function setInvisibles(tr: Transaction, on: boolean) {
  return tr.setMeta(invisiblesKey, on).setMeta("addToHistory", false);
}

export function invisiblesShown(state: EditorState) {
  return invisiblesKey.getState(state)?.on ?? false;
}

function mark(kind: "para" | "break") {
  return () => {
    const span = document.createElement("span");
    span.className = `np-mark np-${kind}`;
    span.setAttribute("aria-hidden", "true");
    return span;
  };
}

function build(state: EditorState) {
  const decorations: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (node.isTextblock) {
      decorations.push(Decoration.widget(pos + node.nodeSize - 1, mark("para"), { side: 1, key: "np-para", ignoreSelection: true }));
      return true;
    }
    if (node.type.name === "hard_break") {
      decorations.push(Decoration.widget(pos, mark("break"), { side: -1, key: "np-break", ignoreSelection: true }));
      return false;
    }
    if (node.isText && node.text) {
      const text = node.text;
      for (let i = text.indexOf(" "); i >= 0; i = text.indexOf(" ", i + 1)) {
        decorations.push(Decoration.inline(pos + i, pos + i + 1, { class: "np-space" }));
      }
      return false;
    }
    return true;
  });
  return DecorationSet.create(state.doc, decorations);
}

export function invisiblesPlugin(initial: boolean) {
  return new Plugin<InvisiblesState>({
    key: invisiblesKey,
    state: {
      init: (_config, state) => ({ on: initial, decorations: initial ? build(state) : DecorationSet.empty }),
      apply(tr, value, _old, state) {
        const meta = tr.getMeta(invisiblesKey) as boolean | undefined;
        const on = meta ?? value.on;
        if (!on) return value.on ? { on, decorations: DecorationSet.empty } : value;
        if (meta !== undefined && !value.on) return { on, decorations: build(state) };
        return tr.docChanged ? { on, decorations: build(state) } : value;
      },
    },
    props: {
      decorations: (state) => invisiblesKey.getState(state)?.decorations,
    },
  });
}

import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { sameBorders } from "@/lib/doc/schema";

/**
 * Neighbouring paragraphs with the same borders share one box, as in Word and
 * Google Docs: the top line is drawn above the first, the bottom line below
 * the last, and between them only a `between` line, if they have one.
 * Marks each paragraph that continues from the one before or into the one
 * after (document.css hides the shared lines).
 */

const key = new PluginKey<DecorationSet>("borders");

function joins(doc: PMNode) {
  const decorations: Decoration[] = [];
  const visit = (parent: PMNode, start: number) => {
    let previous: { node: PMNode; pos: number } | null = null;
    parent.forEach((child, offset) => {
      const pos = start + offset;
      if (child.isTextblock && child.attrs.borders) {
        if (previous && sameBorders(previous.node.attrs.borders, child.attrs.borders)) {
          decorations.push(Decoration.node(previous.pos, previous.pos + previous.node.nodeSize, { class: "border-join-next" }));
          decorations.push(Decoration.node(pos, pos + child.nodeSize, { class: "border-join-prev" }));
        }
        previous = { node: child, pos };
        return;
      }
      previous = null;
      if (!child.isTextblock && !child.isLeaf) visit(child, pos + 1);
    });
  };
  visit(doc, 0);
  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

export function bordersPlugin() {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, state) => joins(state.doc),
      apply: (tr, value) => (tr.docChanged ? joins(tr.doc) : value),
    },
    props: {
      decorations: (state) => key.getState(state),
    },
  });
}

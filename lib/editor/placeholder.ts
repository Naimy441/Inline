import { Plugin } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/** Placeholder text for an empty document and for the empty line under the cursor. */
export function placeholderPlugin(text: string) {
  return new Plugin({
    props: {
      decorations(state) {
        const doc = state.doc;
        if (doc.childCount === 1 && doc.firstChild!.isTextblock && doc.firstChild!.content.size === 0) {
          return DecorationSet.create(doc, [Decoration.node(0, doc.firstChild!.nodeSize, { class: "is-empty", "data-placeholder": text })]);
        }
        return DecorationSet.empty;
      },
    },
  });
}

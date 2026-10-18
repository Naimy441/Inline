import { Selection, TextSelection, type Transaction } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";

/**
 * Make the editor state catch up with a DOM selection change that the browser
 * has made but not yet reported. Call this before building a transaction
 * outside a DOM event (server steps, layout passes): otherwise the view writes
 * the stale selection back as "current" and ProseMirror then ignores the
 * user's newer selection, so a just-selected range reads as empty.
 */
type DomObserver = { flush(): void; forceFlush(): void; flushingSoon: number };

let adoptingSelection = false;

/**
 * Read a browser selection into the editor state before a command or a layout
 * pass runs. The pass's own flush paints whatever the state currently says, so
 * a range the browser has and the state does not must be adopted first — a
 * flush that cannot read it would put the old caret back and the highlight
 * would be gone before Bold runs.
 */
export function syncDomSelection(view: EditorView) {
  if (!adoptingSelection) {
    const visible = readDomSelection(view);
    // A cell or picture selection is already what the next command should use.
    // A range on the page (Shift+End) or a caret Home left at the start of a
    // line can be on screen before the editor has recorded it. A flush paints
    // the state caret, which is still where typing finished.
    if (visible && view.state.selection instanceof TextSelection && view.state.selection.empty && !visible.eq(view.state.selection)) {
      adoptingSelection = true;
      try {
        view.dispatch(view.state.tr.setSelection(visible).setMeta("addToHistory", false));
      } catch {
        // A dispatch during another update can throw; the caller reads the range itself.
      } finally {
        adoptingSelection = false;
      }
    }
  }
  const observer = (view as unknown as { domObserver?: DomObserver }).domObserver;
  if (!view.hasFocus() || !observer) return;
  try {
    // A flush already waiting returns immediately from flush(); run it now.
    if (observer.flushingSoon > -1) observer.forceFlush();
    else observer.flush();
  } catch {
    // Internal API; reading the selection a moment later is harmless.
  }
}

export type HeldRange = { from: number; to: number; anchor: number };

/**
 * What a toolbar press should format. A range read from the page replaces
 * anything remembered earlier. An empty read keeps a range captured moments
 * ago when the caret in the editor state has not moved: the button took focus
 * and the browser dropped the highlight, but the user has not clicked a new
 * spot. A caret that has moved is a new insertion point, so the old range goes.
 */
export function retainHeldSelection(held: HeldRange | null, read: { from: number; to: number } | null, state: { from: number; empty: boolean }): HeldRange | null {
  if (read && read.to > read.from) return { from: read.from, to: read.to, anchor: state.from };
  // A press that drops the highlight leaves the caret on one end of the range.
  // A caret anywhere else is a new insertion point.
  if (held && held.to > held.from && state.empty && (state.from === held.anchor || state.from === held.from || state.from === held.to)) return held;
  return null;
}

/**
 * A phrase the page showed, when the caret is still on one end of it.
 * Shift+Home / Shift+End leave the editor caret there if the range never
 * landed in state, and a toolbar press can drop the highlight onto that end.
 */
export function rangeTouchingCaret(range: { from: number; to: number } | null, caret: number): { from: number; to: number } | null {
  if (!range || range.to <= range.from) return null;
  if (caret === range.from || caret === range.to) return range;
  return null;
}

/**
 * The range showing on the page, when the editor has not recorded it yet.
 * Null for a caret, or when the browser selection sits outside the document.
 */
export function visibleTextSelection(view: EditorView): TextSelection | null {
  const selection = readDomSelection(view);
  return selection && !selection.empty ? selection : null;
}

/**
 * The browser selection inside the editor, as a real text selection.
 * A caret that sits on a page gap or between blocks is moved to the nearest
 * text position. Null when the selection is outside the document.
 */
export function readDomSelection(view: EditorView): TextSelection | null {
  const sel = view.dom.ownerDocument.getSelection();
  if (!sel?.anchorNode || !sel.focusNode) return null;
  if (!view.dom.contains(sel.anchorNode) || !view.dom.contains(sel.focusNode)) return null;
  try {
    return textSelectionNear(view.state.doc, view.posAtDOM(sel.anchorNode, sel.anchorOffset), view.posAtDOM(sel.focusNode, sel.focusOffset));
  } catch {
    return null;
  }
}

/** A text selection at these positions, even when one of them is not inside a text block. */
export function textSelectionNear(doc: PMNode, anchor: number, head: number): TextSelection | null {
  const clamp = (pos: number) => Math.max(0, Math.min(doc.content.size, pos));
  const $anchor = doc.resolve(clamp(anchor));
  const $head = doc.resolve(clamp(head));
  const found = TextSelection.between($anchor, $head, anchor <= head ? 1 : -1);
  if (found instanceof TextSelection && found.$from.parent.inlineContent && found.$to.parent.inlineContent) return found;
  const bias = anchor <= head ? 1 : -1;
  const near = Selection.findFrom($head, bias, true) || Selection.findFrom($head, -bias, true);
  return near instanceof TextSelection ? near : null;
}

/**
 * A layout or spelling pass dispatches a transaction that does not mean to
 * move the caret. If the page is showing a range or a caret the state missed,
 * applying that transaction paints the old caret and the newer one is gone.
 * Keep what the page shows. A picture or gap selection is left alone.
 */
export function keepVisibleSelection(view: EditorView, tr: Transaction): Transaction {
  if (tr.docChanged || tr.selectionSet || !(tr.selection instanceof TextSelection) || !tr.selection.empty) return tr;
  // Spelling and page layout redraw the caret from the editor state. Home can
  // already have moved the on-screen caret; painting the state puts it back
  // where typing finished.
  const visible = readDomSelection(view);
  if (!visible || visible.eq(tr.selection)) return tr;
  return tr.setSelection(visible);
}

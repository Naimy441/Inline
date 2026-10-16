import { TextSelection, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

/**
 * Make the editor state catch up with a DOM selection change that the browser
 * has made but not yet reported. Call this before building a transaction
 * outside a DOM event (server steps, layout passes): otherwise the view writes
 * the stale selection back as "current" and ProseMirror then ignores the
 * user's newer selection, so a just-selected range reads as empty.
 */
type DomObserver = { flush(): void; forceFlush(): void; flushingSoon: number };

/** Read a browser caret move (Ctrl/⌘+End, then Enter) into the editor state before a command runs. */
export function syncDomSelection(view: EditorView) {
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

/**
 * The range showing on the page, when the editor has not recorded it yet.
 * Null for a caret, or when the browser selection sits outside the document.
 */
export function visibleTextSelection(view: EditorView): TextSelection | null {
  const sel = view.dom.ownerDocument.getSelection();
  if (!sel?.anchorNode || !sel.focusNode) return null;
  if (!view.dom.contains(sel.anchorNode) || !view.dom.contains(sel.focusNode)) return null;
  try {
    const anchor = view.posAtDOM(sel.anchorNode, sel.anchorOffset);
    const head = view.posAtDOM(sel.focusNode, sel.focusOffset);
    const selection = TextSelection.create(view.state.doc, anchor, head);
    return selection.empty ? null : selection;
  } catch {
    return null;
  }
}

/**
 * A layout or spelling pass dispatches a transaction that does not mean to
 * move the caret. If the page is showing a range the state missed, applying
 * that transaction paints the old caret and the range is gone. Keep it.
 */
export function keepVisibleSelection(view: EditorView, tr: Transaction): Transaction {
  if (tr.docChanged || tr.selectionSet || !tr.selection.empty) return tr;
  const visible = visibleTextSelection(view);
  if (!visible || visible.eq(tr.selection)) return tr;
  return tr.setSelection(visible);
}

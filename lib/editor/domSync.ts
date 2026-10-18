import type { Node as PMNode } from "prosemirror-model";
import { Selection, TextSelection, type Transaction } from "prosemirror-state";
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
 * A key or a press in the page may move the caret. Cleared after that turn,
 * so a later selection change is the browser dropping a highlight (a layout
 * pass, or the toolbar taking the pointer) and not a new insertion point.
 */
let caretGesture = false;
let clearCaretGesture: ReturnType<typeof setTimeout> | null = null;

function clearCaretGestureSoon() {
  if (clearCaretGesture) clearTimeout(clearCaretGesture);
  // The selection change for End or an arrow can land on the next task. A layout
  // flush after that is not this key: adopting the change clears the gesture first.
  clearCaretGesture = setTimeout(() => {
    caretGesture = false;
    clearCaretGesture = null;
  }, 100);
}

function consumeCaretGesture() {
  caretGesture = false;
  if (clearCaretGesture) clearTimeout(clearCaretGesture);
  clearCaretGesture = null;
}

export function noteCaretGesture() {
  caretGesture = true;
  clearCaretGestureSoon();
}

/** True while a key or a press in the page can still be the cause of a caret move. */
export function hasCaretGesture() {
  return caretGesture;
}

/** Drop a gesture the tests noted, so a later case is not treated as that press. */
export function resetCaretGesture() {
  caretGesture = false;
  if (clearCaretGesture) clearTimeout(clearCaretGesture);
  clearCaretGesture = null;
}

/**
 * The on-screen caret, including a collapsed one. Layout, spelling, and
 * pagination paint whatever the editor state says, so this is written into
 * that state before they read it. A range the editor already recorded stays
 * (a picture, cells, or a shorter phrase). A caret replaces that range only
 * when the reader just pressed a key or the page; otherwise the highlight
 * dropped on its own and the phrase is still the one to format. Focus leaving
 * the page is not a caret move: the phrase held for a font or size change stays put.
 */
export function commitDomCaret(view: EditorView) {
  if (adoptingSelection) return;
  const onScreen = readDomSelection(view);
  const stateSel = view.state.selection;
  if (!onScreen || !(stateSel instanceof TextSelection) || onScreen.eq(stateSel)) return;
  if (!stateSel.empty && !onScreen.empty) return;
  if (!stateSel.empty && onScreen.empty && (!view.hasFocus() || !caretGesture)) return;
  if (caretGesture) consumeCaretGesture();
  adoptingSelection = true;
  try {
    view.dispatch(view.state.tr.setSelection(onScreen).setMeta("addToHistory", false));
  } catch {
    // A dispatch during another update can throw; the caller reads the range itself.
  } finally {
    adoptingSelection = false;
  }
}

/**
 * Read a browser selection into the editor state before a command or a layout
 * pass runs. The pass's own flush paints whatever the state currently says, so
 * the caret the page is showing is committed first — a flush that cannot read
 * it would put the caret the user just left back on the page.
 */
export function syncDomSelection(view: EditorView) {
  commitDomCaret(view);
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

/** True for a node inside the editor, including the editor element itself. `contains` does not count the node it is called on. */
function inEditor(view: EditorView, node: Node): boolean {
  return node === view.dom || view.dom.contains(node);
}

/**
 * An endpoint Shift+Home / Shift+End left on the editor element, or just
 * outside it. The browser still reports the phrase, but one side is not a
 * text node inside the page. Clamp that side to the editor edge.
 */
function clampedEndpoint(view: EditorView, node: Node, offset: number, otherOffset: number): { node: Node; offset: number } {
  if (inEditor(view, node)) return { node, offset };
  return { node: view.dom, offset: otherOffset > 0 ? 0 : view.dom.childNodes.length };
}

/**
 * The browser selection inside the editor, caret included. A caret that sits
 * on a page gap or between blocks moves to the nearest text position. Null
 * when the selection is outside the document.
 */
export function readDomSelection(view: EditorView): TextSelection | null {
  const sel = view.dom.ownerDocument.getSelection();
  if (!sel?.anchorNode || !sel.focusNode) return null;
  if (!inEditor(view, sel.anchorNode) && !inEditor(view, sel.focusNode)) return null;
  const anchor = clampedEndpoint(view, sel.anchorNode, sel.anchorOffset, sel.focusOffset);
  const focus = clampedEndpoint(view, sel.focusNode, sel.focusOffset, sel.anchorOffset);
  try {
    return textSelectionNear(view.state.doc, view.posAtDOM(anchor.node, anchor.offset), view.posAtDOM(focus.node, focus.offset));
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
 * A layout, spelling, or pagination pass dispatches a transaction that does
 * not mean to move the caret. The caret on the page wins over the one the
 * transaction still carries. A transaction built before that caret was
 * committed cannot put the old one back. A picture or gap selection is left alone.
 */
export function keepVisibleSelection(view: EditorView, tr: Transaction): Transaction {
  // Typing and arrow keys pick their own selection. A layout flush does not:
  // it carries addToHistory false, and painting it must not drop a phrase the
  // page is showing but the editor has not recorded yet.
  if (tr.selectionSet && tr.getMeta("addToHistory") !== false) return tr;
  if (!(view.state.selection instanceof TextSelection) || !(tr.selection instanceof TextSelection)) return tr;
  const onScreen = readDomSelection(view);
  const stateSel = view.state.selection;
  if (onScreen && !onScreen.empty && stateSel.empty) {
    const from = tr.mapping.map(onScreen.from, 1);
    const to = tr.mapping.map(onScreen.to, -1);
    if (from < to && to <= tr.doc.content.size) return tr.setSelection(TextSelection.create(tr.doc, from, to));
  }
  if (tr.docChanged || tr.selectionSet) return tr;
  if (!tr.selection.empty) return tr;
  if (!tr.selection.eq(stateSel)) {
    // The pass captured an older caret. The state may already have the one the
    // user moved to; the page may have a still newer one.
    if (onScreen && stateSel.empty && !onScreen.eq(stateSel)) return tr.setSelection(onScreen);
    return tr.setSelection(stateSel);
  }
  if (onScreen && stateSel.empty && !onScreen.eq(tr.selection)) return tr.setSelection(onScreen);
  return tr;
}

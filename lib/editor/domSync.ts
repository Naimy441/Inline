import type { EditorView } from "prosemirror-view";

/**
 * Make the editor state catch up with a DOM selection change that the browser
 * has made but not yet reported. Call this before building a transaction
 * outside a DOM event (server steps, layout passes): otherwise the view writes
 * the stale selection back as "current" and ProseMirror then ignores the
 * user's newer selection, so a just-selected range reads as empty.
 */
export function syncDomSelection(view: EditorView) {
  const observer = (view as unknown as { domObserver?: { flush(): void } }).domObserver;
  if (!view.hasFocus() || !observer) return;
  try {
    observer.flush();
  } catch {
    // Internal API; reading the selection a moment later is harmless.
  }
}

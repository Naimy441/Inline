"use client";

import { useSyncExternalStore } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";

/**
 * An unrestricted Canvas is one HTML page, shown as the author wrote it. The
 * frame allows scripts but gives them an opaque origin, so the page cannot
 * read Inline's cookies, storage, or API. The page is read from the document
 * on every change, so Claude's writes appear as they land.
 */
export function UnrestrictedCanvasFrame({ session, title }: { session: DocumentSession; title: string }) {
  const state = useSyncExternalStore(session.editor.subscribe, session.editor.get, session.editor.get);
  const design = state?.doc.attrs.canvas;
  if (!state || design?.format !== 2 || typeof design.html !== "string") return null;
  return <iframe className="unrestricted-canvas" title={title} sandbox="allow-scripts" srcDoc={design.html} />;
}

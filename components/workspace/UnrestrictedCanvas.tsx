"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";

/** Tells the editor how tall the page is. The frame has an opaque origin, so this is the only way out. */
const HEIGHT_REPORTER = (token: string) =>
  `<script>(function(){var t=${JSON.stringify(token)};function send(){var h=Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);parent.postMessage({inlineCanvasHeight:h,token:t},"*")}addEventListener("load",send);if(window.ResizeObserver)new ResizeObserver(send).observe(document.documentElement);send()})()</script>`;

function withReporter(html: string, token: string) {
  const script = HEIGHT_REPORTER(token);
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${script}</body>`) : `${html}${script}`;
}

/**
 * An unrestricted Canvas is one HTML page, shown as the author wrote it. The
 * frame allows scripts but gives them an opaque origin, so the page cannot
 * read Inline's cookies, storage, or API. The page is read from the document
 * on every change, so Claude's writes appear as they land. The frame is as
 * tall as the page, so the editor scrolls it and nothing is cut off.
 */
export function UnrestrictedCanvasFrame({ session, title }: { session: DocumentSession; title: string }) {
  const state = useSyncExternalStore(session.editor.subscribe, session.editor.get, session.editor.get);
  const frame = useRef<HTMLIFrameElement>(null);
  const token = useMemo(() => Math.random().toString(36).slice(2), []);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { inlineCanvasHeight?: unknown; token?: unknown } | null;
      if (event.source !== frame.current?.contentWindow || data?.token !== token || typeof data.inlineCanvasHeight !== "number") return;
      setHeight(Math.min(Math.max(Math.ceil(data.inlineCanvasHeight), 200), 200_000));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [token]);
  const design = state?.doc.attrs.canvas;
  if (!state || design?.format !== 2 || typeof design.html !== "string") return null;
  return <iframe ref={frame} className="unrestricted-canvas" title={title} sandbox="allow-scripts" scrolling="no" style={height ? { height } : undefined} srcDoc={withReporter(design.html, token)} />;
}

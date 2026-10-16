"use client";

import { ArrowDown, ArrowUp, CloudOff, FileText, PenLine, Sparkles, X } from "lucide-react";
import type { EditorState } from "prosemirror-state";
import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { PdfImportMeta } from "@/lib/doc/settings";

/**
 * Shown at the top of the canvas while the document's connection is down.
 * Brief blips (under a couple of seconds) don't flash it.
 */
export function OfflineNotice({ offline }: { offline: boolean }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!offline) {
      setShow(false);
      return;
    }
    const timer = setTimeout(() => setShow(true), 1500);
    return () => clearTimeout(timer);
  }, [offline]);
  if (!show) return null;
  return (
    <div className="offline-notice" role="status">
      <CloudOff size={15} />
      <span>
        <strong>You&apos;re offline.</strong> Keep writing: your edits stay in this tab and sync when the connection is back.
      </span>
    </div>
  );
}

/**
 * When Claude is working somewhere off screen, a chip at the canvas edge
 * points to it; clicking it scrolls there.
 */
export function AgentLocator({ canvas, state, active, label }: { canvas: RefObject<HTMLElement | null>; state: EditorState | null; active: boolean; label: string }) {
  const [where, setWhere] = useState<{ side: "above" | "below"; left: number; top: number; bottom: number } | null>(null);

  useEffect(() => {
    const element = canvas.current;
    if (!element || !active) {
      setWhere(null);
      return;
    }
    let frame = 0;
    const check = () => {
      frame = 0;
      const caret = element.querySelector<HTMLElement>(".doc-content .agent-caret");
      if (!caret) return setWhere(null);
      const box = caret.getBoundingClientRect();
      const view = element.getBoundingClientRect();
      const side = box.bottom < view.top + 8 ? "above" : box.top > view.bottom - 72 ? "below" : null;
      setWhere(side ? { side, left: view.left + view.width / 2, top: view.top + 12, bottom: window.innerHeight - view.bottom + 72 } : null);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    schedule();
    element.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      element.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [canvas, state, active]);

  if (!where) return null;
  const button = (
    <button
      type="button"
      className={`agent-locator is-${where.side}`}
      style={where.side === "below" ? { left: where.left, bottom: where.bottom } : undefined}
      onClick={() => canvas.current?.querySelector(".doc-content .agent-caret")?.scrollIntoView({ block: "center", behavior: "smooth" })}
    >
      <Sparkles size={13} />
      <span className="agent-locator-text">{label || "Claude is working"}</span>
      {where.side === "above" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
    </button>
  );
  // Above the page, the chip joins the notice stack so it sits under the conversion
  // bar instead of covering it. Below, it stays fixed over the canvas edge.
  if (where.side === "above") {
    const stack = canvas.current?.querySelector(".canvas-notices");
    if (stack) return createPortal(button, stack);
  }
  return button;
}

/**
 * For a document imported from a PDF: how far Claude is with rebuilding its
 * pages as text, a way to start or continue that, and the switch for the
 * original annotations. Gone once the conversion is done (the View menu
 * keeps the switch).
 */
export function PdfImportNotice({ pdf, working, chatOpen, onConvert, onShowChat, onToggleAnnotations }: { pdf: PdfImportMeta; working: boolean; chatOpen: boolean; onConvert: () => void; onShowChat: () => void; onToggleAnnotations: () => void }) {
  const [hidden, setHidden] = useState(false);
  if (pdf.status === "done" || hidden) return null;
  const done = Math.min(pdf.pages, pdf.converted.length);
  const converting = pdf.status === "converting";
  const annotations = pdf.inkPages.length > 0;
  return (
    <div className="pdf-notice" role="status">
      {converting ? <Sparkles size={15} className={working ? "pulse" : undefined} /> : <FileText size={15} />}
      <span className="pdf-notice-text">
        {converting ? (
          <>
            <strong>Claude is converting this PDF</strong> into editable text: {done} of {pdf.pages} page{pdf.pages === 1 ? "" : "s"} done.
          </>
        ) : (
          <>
            <strong>
              {pdf.pages - done} of {pdf.pages} page{pdf.pages === 1 ? " is" : "s are"} still {pdf.pages - done === 1 ? "a picture" : "pictures"} of the PDF.
            </strong>{" "}
            Claude can rebuild {pdf.pages - done === 1 ? "it" : "them"} as editable text.
          </>
        )}
      </span>
      {converting ? (
        !chatOpen && (
          <button type="button" className="pdf-notice-action" onClick={onShowChat}>
            Show progress
          </button>
        )
      ) : (
        <button type="button" className="pdf-notice-action is-primary" onClick={onConvert}>
          {done ? "Continue converting" : "Convert with Claude"}
        </button>
      )}
      {annotations && (
        <button type="button" className={`pdf-notice-action${pdf.showAnnotations ? " is-on" : ""}`} onClick={onToggleAnnotations} title="Show the handwriting and markup the PDF had, where it was on the original pages">
          <PenLine size={13} /> {pdf.showAnnotations ? "Hide annotations" : "Show annotations"}
        </button>
      )}
      {!converting && (
        <button type="button" className="pdf-notice-close" aria-label="Dismiss" onClick={() => setHidden(true)}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}

"use client";

import { ArrowDown, ArrowUp, CloudOff, Sparkles } from "lucide-react";
import type { EditorState } from "prosemirror-state";
import { useEffect, useState, type RefObject } from "react";

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
    <div className="canvas-notice">
      <div className="offline-notice" role="status">
        <CloudOff size={15} />
        <span>
          <strong>You&apos;re offline.</strong> Keep writing: your edits stay in this tab and sync when the connection is back.
        </span>
      </div>
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
  return (
    <button
      type="button"
      className={`agent-locator is-${where.side}`}
      style={where.side === "above" ? { left: where.left, top: where.top } : { left: where.left, bottom: where.bottom }}
      onClick={() => canvas.current?.querySelector(".doc-content .agent-caret")?.scrollIntoView({ block: "center", behavior: "smooth" })}
    >
      <Sparkles size={13} />
      <span className="agent-locator-text">{label || "Claude is working"}</span>
      {where.side === "above" ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
    </button>
  );
}

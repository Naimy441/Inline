"use client";

import { Check, ChevronDown, ChevronUp, Undo2 } from "lucide-react";
import type { DocumentSession } from "@/lib/client/documentSession";

const mod = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? "⌘" : "Ctrl+";

/** Floating summary of Claude's pending changes, like Cursor's review bar. */
export function ReviewBar({ session, count }: { session: DocumentSession; count: number }) {
  if (!count) return null;
  return (
    <div className="review-bar" role="region" aria-label="Review Claude's changes">
      <span className="review-bar-count">
        <span className="review-bar-dot" />
        {count} change{count === 1 ? "" : "s"} by Claude
      </span>
      <div className="review-bar-nav">
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Previous change" data-tip="Previous change  ⌥[" onClick={() => session.gotoChange(-1)}>
          <ChevronUp size={15} />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Next change" data-tip="Next change  ⌥]" onClick={() => session.gotoChange(1)}>
          <ChevronDown size={15} />
        </button>
      </div>
      <button type="button" className="btn btn-ghost btn-sm" data-tip={`Undo the change at the cursor: ${mod}⇧⌫`} onClick={() => void session.review("reject", "all")}>
        <Undo2 size={14} />
        <span className="btn-label">Undo all</span>
      </button>
      <button type="button" className="btn btn-primary btn-sm" data-tip={`Keep the change at the cursor: ${mod}⇧⏎`} onClick={() => void session.review("accept", "all")}>
        <Check size={14} />
        <span className="btn-label">Keep all</span>
      </button>
    </div>
  );
}

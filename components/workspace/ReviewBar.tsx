"use client";

import { Check, ChevronDown, ChevronUp, Undo2 } from "lucide-react";
import type { DocumentSession } from "@/lib/client/documentSession";
import { isUserSuggestion, type HunkJSON } from "@/lib/doc/review";

const mod = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? "⌘" : "Ctrl+";

function summary(hunks: HunkJSON[]) {
  const suggestions = hunks.filter(isUserSuggestion).length;
  const claude = hunks.length - suggestions;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (!suggestions)
    return (
      <>
        {plural(claude, "change")}
        <span className="review-bar-by"> by Claude</span>
      </>
    );
  if (!claude) return plural(suggestions, "suggestion");
  return `${plural(claude, "change")} by Claude, ${plural(suggestions, "suggestion")}`;
}

/** Floating summary of pending changes (Claude's edits and suggestions), like Cursor's review bar. */
export function ReviewBar({ session, hunks }: { session: DocumentSession; hunks: HunkJSON[] }) {
  if (!hunks.length) return null;
  const onlySuggestions = hunks.every(isUserSuggestion);
  return (
    <div className={`review-bar${onlySuggestions ? " is-suggestions" : ""}`} role="region" aria-label="Review pending changes">
      <span className="review-bar-count">
        <span className="review-bar-dot" />
        <span className="review-bar-text">{summary(hunks)}</span>
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

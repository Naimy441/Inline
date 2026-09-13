"use client";

import type { TropeHit } from "@/lib/writing/tropes";
import type { WritingLint } from "@/lib/writing/lint";

type Props = {
  lint: WritingLint;
  tropes: TropeHit[];
  onClose: () => void;
  onJump: (find: string) => void;
  onGrammar: () => void;
  onClean: () => void;
  onTone: () => void;
};

export function LintPanel({ lint, tropes, onClose, onJump, onGrammar, onClean, onTone }: Props) {
  return (
    <aside className="lint-drawer">
      <div className="lint-head">
        <strong>Writing lint</strong>
        <div className="lint-head-actions">
          <button type="button" onClick={onGrammar}>
            Fix grammar
          </button>
          <button type="button" onClick={onClean}>
            Clean AI
          </button>
          <button type="button" onClick={onTone}>
            Suggest tone
          </button>
          <button type="button" className="dialog-text-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <div className="lint-metrics">
        <Metric label="Words" value={String(lint.words)} />
        <Metric label="Paragraphs" value={String(lint.paragraphs)} />
        <Metric label="Pages" value={`~${lint.pages}`} />
        <Metric label="Diversity" value={`${Math.round(lint.diversity * 100)}%`} />
        <Metric label="Level" value={lint.vocabularyLevel} />
        <Metric label="Grade" value={String(Math.max(0, Math.round(lint.gradeLevel)))} />
      </div>
      <ul className="lint-issues">
        {lint.issues.map((issue) => (
          <li key={issue.id}>
            <button type="button" onClick={() => issue.find && onJump(issue.find)} disabled={!issue.find}>
              <em data-severity={issue.severity}>{issue.severity}</em>
              <span>
                <strong>{issue.title}</strong>
                {issue.detail}
              </span>
            </button>
          </li>
        ))}
        {tropes.map((hit) => (
          <li key={hit.id}>
            <button type="button" onClick={() => hit.find && onJump(hit.find)} disabled={!hit.find}>
              <em data-severity="warn">ai</em>
              <span>
                <strong>{hit.title}</strong>
                {hit.find ? `Found “${clip(hit.find, 72)}”` : "Hidden tokens in the text"}
              </span>
            </button>
          </li>
        ))}
        {!lint.issues.length && !tropes.length && <li className="lint-empty">No flags. The draft looks clean.</li>}
      </ul>
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function clip(text: string, max: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

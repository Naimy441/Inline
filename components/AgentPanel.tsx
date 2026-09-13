"use client";

import { useEffect, useRef } from "react";
import type { AgentSelection, AgentTurn, PendingEdit } from "@/lib/agent/types";

type Props = {
  open: boolean;
  minimized: boolean;
  busy: boolean;
  error: string | null;
  prompt: string;
  context: AgentSelection | null;
  turns: AgentTurn[];
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  onClearContext: () => void;
  onMinimizedChange: (value: boolean) => void;
  onClose: () => void;
  onNewChat: () => void;
  onJump: (id: string) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
};

export function AgentPanel({
  open,
  minimized,
  busy,
  error,
  prompt,
  context,
  turns,
  onPromptChange,
  onSubmit,
  onClearContext,
  onMinimizedChange,
  onClose,
  onNewChat,
  onJump,
  onAccept,
  onReject,
  onAcceptAll,
  onRejectAll,
}: Props) {
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pending = turns.flatMap((turn) => turn.edits.filter((edit) => edit.status === "pending"));

  useEffect(() => {
    if (open && !minimized) inputRef.current?.focus();
  }, [open, minimized]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    thread.scrollTop = thread.scrollHeight;
  }, [turns, busy]);

  if (!open) return null;

  if (minimized) {
    return (
      <aside className="comments-rail">
        <button type="button" className="comments-rail-btn" onClick={() => onMinimizedChange(false)}>
          Agent{pending.length ? ` · ${pending.length}` : ""}
        </button>
      </aside>
    );
  }

  const title = turns[0]?.prompt.trim() || "New chat";

  return (
    <aside className="agent-panel">
      <header className="chat-head">
        <div className="chat-tabs">
          <span className="chat-tab" title={title}>
            {truncate(title, 28)}
          </span>
        </div>
        <div className="chat-head-actions">
          <button type="button" className="chat-icon-btn" title="New chat" onClick={onNewChat}>
            <PlusIcon />
          </button>
          <button type="button" className="chat-icon-btn" title="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
      </header>

      <div className="chat-thread" ref={threadRef}>
        {turns.map((turn) => (
          <TurnBlock
            key={turn.id}
            turn={turn}
            onJump={onJump}
            onAccept={onAccept}
            onReject={onReject}
          />
        ))}
        {busy && (
          <div className="chat-status">
            <span className="chat-status-dot" />
            Working on the selection
          </div>
        )}
        {error && <p className="chat-error">{error}</p>}
      </div>

      {pending.length > 0 && (
        <div className="chat-review">
          <button type="button" onClick={onRejectAll}>
            Undo All
          </button>
          <button type="button" onClick={onAcceptAll}>
            Keep All
          </button>
          <button type="button" className="chat-review-primary" onClick={() => onJump(pending[0].id)}>
            Review
          </button>
        </div>
      )}

      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {context && (
          <div className="chat-context">
            <button type="button" className="chat-context-chip" onClick={() => pending[0] && onJump(pending[0].id)}>
              <SelectionIcon />
              <span>Selection</span>
              <em>{wordCount(context.text)}</em>
            </button>
            <button type="button" className="chat-context-remove" onClick={onClearContext} aria-label="Remove selection">
              <CloseIcon />
            </button>
          </div>
        )}
        <textarea
          ref={inputRef}
          rows={3}
          value={prompt}
          placeholder="Plan, search, ask to edit…"
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <div className="chat-composer-bar">
          <span className="chat-mode">Agent</span>
          <button type="submit" className="chat-send" disabled={busy || !prompt.trim()} aria-label="Send">
            <SendIcon />
          </button>
        </div>
      </form>
    </aside>
  );
}

function TurnBlock({
  turn,
  onJump,
  onAccept,
  onReject,
}: {
  turn: AgentTurn;
  onJump: (id: string) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const applied = turn.edits.filter((edit) => edit.status !== "missed").length;
  return (
    <section className="chat-turn">
      <div className="chat-user">
        <p>{turn.prompt}</p>
        {turn.selection && (
          <div className="chat-user-chip">
            <SelectionIcon />
            Selection
          </div>
        )}
      </div>
      {applied > 0 && (
        <div className="chat-tool">
          Proposed {applied} {applied === 1 ? "edit" : "edits"} in the document
        </div>
      )}
      <div className="chat-assistant">
        <p>{turn.message}</p>
        {turn.mock && <p className="chat-muted">Mock proposal — add an API key for a model response.</p>}
        {turn.edits.map((edit) => (
          <Hunk key={edit.id} edit={edit} onJump={onJump} onAccept={onAccept} onReject={onReject} />
        ))}
      </div>
    </section>
  );
}

function Hunk({
  edit,
  onJump,
  onAccept,
  onReject,
}: {
  edit: PendingEdit;
  onJump: (id: string) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <div className={`chat-hunk is-${edit.status}`}>
      <button type="button" className="chat-hunk-file" onClick={() => onJump(edit.id)}>
        Document
      </button>
      <pre>
        <code>
          {edit.find && <span className="chat-del">- {edit.find}</span>}
          <span className="chat-add">+ {edit.replace || "(delete)"}</span>
        </code>
      </pre>
      {edit.status === "pending" ? (
        <div className="chat-hunk-actions">
          <button type="button" onClick={() => onReject(edit.id)}>
            Undo
          </button>
          <button type="button" className="chat-keep" onClick={() => onAccept(edit.id)}>
            Keep
          </button>
        </div>
      ) : (
        <p className="chat-hunk-status">{statusLabel(edit.status)}</p>
      )}
    </div>
  );
}

function statusLabel(status: PendingEdit["status"]) {
  if (status === "accepted") return "Kept";
  if (status === "rejected") return "Undone";
  if (status === "missed") return "Could not find that text.";
  return "";
}

function truncate(value: string, max: number) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function wordCount(text: string) {
  const parts = text.trim().split(/\s+/);
  return parts[0] === "" ? "0 words" : `${parts.length} ${parts.length === 1 ? "word" : "words"}`;
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 12.5V3.5M4.5 7 8 3.5 11.5 7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SelectionIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.2" y="2.5" width="9.6" height="11" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6 6.5h4M6 8.7h4M6 10.9h2.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

"use client";

import { Brain, ChevronRight, CircleAlert, FileText, Image as ImageIcon, PenLine, RotateCcw, TextQuote } from "lucide-react";
import { memo, useState } from "react";
import type { AssistantMessage, AssistantPart, ChatMessage, UserMessage } from "@/lib/agent/types";
import { Markdown } from "@/components/agent/Markdown";
import { ToolCall } from "@/components/agent/ToolCall";

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatTokens(count: number) {
  return count >= 1000 ? `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k` : String(count);
}

export const UserBubble = memo(function UserBubble({ message }: { message: UserMessage }) {
  return (
    <div className="msg msg-user">
      {(message.selection || Boolean(message.attachments?.length)) && (
        <div className="msg-context">
          {message.selection && (
            <span className="chip chip-quote" title={message.selection.text}>
              <TextQuote size={12} />
              <span className="chip-text">{message.selection.text}</span>
            </span>
          )}
          {message.attachments?.map((attachment) => (
            <span key={attachment.id} className="chip">
              {attachment.kind === "image" ? <ImageIcon size={12} /> : <FileText size={12} />}
              <span className="chip-text">{attachment.name}</span>
            </span>
          ))}
        </div>
      )}
      {message.text && <div className="msg-user-text">{message.text}</div>}
    </div>
  );
});

function Thinking({ text, done }: { text: string; done?: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = text.trim().split("\n").filter(Boolean).pop() ?? "";
  return (
    <div className={`thinking${open ? " is-open" : ""}`}>
      <button type="button" className="thinking-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <Brain size={14} />
        <span className={done ? undefined : "shimmer"}>{done ? "Thought" : "Thinking"}</span>
        {!open && !done && preview && <span className="thinking-preview">{preview}</span>}
        <ChevronRight size={13} className="tool-chevron" />
      </button>
      {open && text && <div className="thinking-body">{text}</div>}
    </div>
  );
}

function Part({ part, streaming }: { part: AssistantPart; streaming: boolean }) {
  if (part.type === "text") return part.text ? <Markdown text={part.text} streaming={streaming} /> : null;
  if (part.type === "thinking") return part.text || !part.done ? <Thinking text={part.text} done={part.done || !streaming} /> : null;
  if (part.name === "TodoWrite") return null;
  return <ToolCall part={part} />;
}

export const AssistantView = memo(function AssistantView({
  message,
  isLast,
  pending,
  onRetry,
  onReview,
  documentId,
  onRestore,
}: {
  message: AssistantMessage;
  isLast: boolean;
  /** The open document, which "Restore to before" applies to. */
  documentId?: string;
  /** Put the open document back to the version saved before this reply's edits. */
  onRestore?: (versionId: string) => void;
  /** This turn's changes still awaiting review. */
  pending: TurnHunk[];
  onRetry: () => void;
  onReview: (action: "next" | "accept" | "reject", ids: string[]) => void;
}) {
  const streaming = message.status === "streaming";
  const changes = message.changes ?? [];
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.removed, 0);
  const [showDiff, setShowDiff] = useState(false);
  const pendingIds = pending.map((hunk) => hunk.id);
  const restorable = changes.find((change) => change.documentId === documentId)?.checkpoint;
  return (
    <div className="msg msg-assistant">
      {message.parts.map((part) => (
        <Part key={`${part.type}-${part.id}`} part={part} streaming={streaming} />
      ))}
      {streaming && !message.parts.length && <div className="msg-pending shimmer">Working…</div>}
      {message.status === "stopped" && <div className="msg-note">Stopped.{message.error ? ` ${message.error}` : ""}</div>}
      {message.status === "error" && (
        <div className="msg-error" role="alert">
          <CircleAlert size={15} />
          <div className="msg-error-text">
            <Markdown text={message.error ?? "Something went wrong."} />
          </div>
          {isLast && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
              <RotateCcw size={13} /> <span className="btn-label">Retry</span>
            </button>
          )}
        </div>
      )}
      {!streaming && changes.length > 0 && (
        <div className="change-card">
          <PenLine size={14} />
          <span className="change-card-text">
            Edited {changes.length === 1 ? <strong>{changes[0]!.title}</strong> : `${changes.length} documents`}
            <span className="change-stat add">+{added}</span>
            <span className="change-stat del">−{removed}</span>
            <span className="change-unit">words</span>
          </span>
          {pending.length === 0 && restorable && onRestore && (
            <span className="change-card-actions">
              <button type="button" className="link-btn" title="Put the document back as it was before this reply's edits" onClick={() => onRestore(restorable)}>
                Restore to before
              </button>
            </span>
          )}
          {pending.length > 0 && (
            <span className="change-card-actions">
              <button type="button" className="link-btn" aria-expanded={showDiff} onClick={() => setShowDiff((value) => !value)}>
                {showDiff ? "Hide" : "Show"} {pending.length} change{pending.length === 1 ? "" : "s"}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onReview("reject", pendingIds)}>
                Undo all
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => onReview("accept", pendingIds)}>
                Keep all
              </button>
            </span>
          )}
        </div>
      )}
      {!streaming && showDiff && pending.length > 0 && (
        <ul className="turn-diff" aria-label="Changes in this reply">
          {pending.map((hunk) => (
            <li key={hunk.id} className="turn-diff-item">
              <button type="button" className="turn-diff-text" title="Show in the document" onClick={() => onReview("next", [hunk.id])}>
                {hunk.deletedText ? <del className="change-stat del">{clip(hunk.deletedText)}</del> : null}
                {hunk.insertedText ? <ins className="change-stat add">{clip(hunk.insertedText)}</ins> : null}
                {!hunk.deletedText && !hunk.insertedText ? <span className="change-unit">Formatting change</span> : null}
              </button>
              <span className="turn-diff-actions">
                <button type="button" className="btn btn-ghost btn-sm" aria-label="Undo this change" onClick={() => onReview("reject", [hunk.id])}>
                  Undo
                </button>
                <button type="button" className="btn btn-secondary btn-sm" aria-label="Keep this change" onClick={() => onReview("accept", [hunk.id])}>
                  Keep
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {!streaming && message.usage && (
        <div className="msg-meta">
          {formatDuration(message.usage.durationMs)} · {formatTokens(message.usage.outputTokens)} tokens{message.usage.costUsd > 0 ? ` · $${message.usage.costUsd < 0.01 ? "<0.01" : message.usage.costUsd.toFixed(2)}` : ""}{message.model ? ` · ${modelLabel(message.model)}` : ""}
        </div>
      )}
    </div>
  );
});

/** A pending change as the chat shows it. */
export type TurnHunk = { id: string; turn?: string; deletedText?: string; insertedText?: string };

const NO_HUNKS: TurnHunk[] = [];

function clip(text: string, max = 160) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function MessageList({
  messages,
  hunks,
  onRetry,
  onReview,
  documentId,
  onRestore,
}: {
  messages: ChatMessage[];
  /** Pending changes in the open document; each card acts only on its own turn's. */
  hunks: ReadonlyArray<TurnHunk>;
  onRetry: () => void;
  onReview: (action: "next" | "accept" | "reject", ids: string[]) => void;
  documentId?: string;
  onRestore?: (versionId: string) => void;
}) {
  const byTurn = new Map<string, TurnHunk[]>();
  for (const hunk of hunks) {
    if (!hunk.turn) continue;
    const list = byTurn.get(hunk.turn) ?? [];
    list.push(hunk);
    byTurn.set(hunk.turn, list);
  }
  return (
    <>
      {messages.map((message, index) =>
        message.role === "user" ? (
          <UserBubble key={message.id} message={message} />
        ) : (
          <AssistantView
            key={message.id}
            message={message}
            isLast={index === messages.length - 1}
            pending={byTurn.get(message.id) ?? NO_HUNKS}
            onRetry={onRetry}
            onReview={onReview}
            documentId={documentId}
            onRestore={onRestore}
          />
        ),
      )}
    </>
  );
}

/** "claude-sonnet-5-5" → "Sonnet 5.5"; unknown ids are shown as they are. */
function modelLabel(id: string) {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/.exec(id);
  if (!match) return id;
  const [, family, major, minor] = match;
  return `${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
}

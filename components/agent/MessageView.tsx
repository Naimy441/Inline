"use client";

import { ChevronRight, CircleAlert, FileText, Image as ImageIcon, PenLine, RotateCcw, TextQuote } from "lucide-react";
import { memo, useMemo, useRef, useState } from "react";
import type { AssistantMessage, AssistantPart, ChatMessage, ThinkingPart, UserMessage } from "@/lib/agent/types";
import { Spark } from "@/components/agent/Activity";
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
      {(message.selection?.text.trim() || Boolean(message.attachments?.length)) && (
        <div className="msg-context">
          {message.selection?.text.trim() && (
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

function thoughtFor(ms: number | undefined) {
  if (ms === undefined) return "Thought";
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 60 ? `Thought for ${seconds}s` : `Thought for ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Claude's reasoning, streamed in as it thinks. The newest block in the
 * latest reply is open so it can be read live; earlier ones fold to one line.
 * The block grows with its text rather than scrolling inside itself.
 */
function Reasoning({ part, live, latest }: { part: ThinkingPart; live: boolean; latest: boolean }) {
  // Once the user opens or folds a block, that choice sticks.
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? latest;
  const hasText = Boolean(part.text.trim());
  const preview = !open && live ? (part.text.trim().split("\n").filter(Boolean).pop() ?? "") : "";
  return (
    <div className={`reasoning${open ? " is-open" : ""}${live ? " is-live" : ""}`}>
      <button type="button" className="reasoning-head" onClick={() => setChoice(!open)} aria-expanded={open} disabled={!hasText}>
        <Spark size={14} still={!live} />
        <span className={live ? "shimmer" : undefined}>{live ? "Thinking" : thoughtFor(part.durationMs)}</span>
        {preview && <span className="reasoning-preview">{preview}</span>}
        {hasText && <ChevronRight size={13} className="tool-chevron" />}
      </button>
      {open && hasText && (
        <div className="reasoning-body">
          <Markdown text={part.text} streaming={live} />
        </div>
      )}
    </div>
  );
}

function Part({ part, streaming, writing, latest }: { part: AssistantPart; streaming: boolean; writing?: boolean; latest?: boolean }) {
  if (part.type === "text") return part.text ? <Markdown text={part.text} streaming={streaming} caret={writing} /> : null;
  if (part.type === "thinking") return part.text || (streaming && !part.done) ? <Reasoning part={part} live={streaming && !part.done} latest={Boolean(latest)} /> : null;
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
  latestThinking,
}: {
  message: AssistantMessage;
  isLast: boolean;
  /** The reasoning block shown open: the newest one, in the latest reply only. */
  latestThinking?: string;
  /** The open document, which "Restore to before" applies to. */
  documentId?: string;
  /** Put the open document back to the version saved before this reply's edits. */
  onRestore?: (versionId: string, messageId: string) => void;
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
      {message.parts.map((part, index) => (
        <Part key={`${part.type}-${part.id}`} part={part} streaming={streaming} writing={streaming && part.type === "text" && index === message.parts.length - 1} latest={part.type === "thinking" && part.id === latestThinking} />
      ))}
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
              <button type="button" className="link-btn" title="Put the document back as it was before this reply's edits" onClick={() => onRestore(restorable, message.id)}>
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
          {formatDuration(message.usage.durationMs)} · {formatTokens(message.usage.outputTokens)} tokens
          {message.usage.costUsd > 0 && (
            <>
              {" · "}
              <span data-tip="Cost of this reply">{message.usage.costUsd < 0.01 ? "<$0.01" : `$${message.usage.costUsd.toFixed(2)}`}</span>
            </>
          )}
          {message.model ? ` · ${modelLabel(message.model)}` : ""}
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
  onRestore?: (versionId: string, messageId: string) => void;
}) {
  const byTurn = useStableGroups(hunks);
  const last = messages[messages.length - 1];
  const latestThinking = last?.role === "assistant" ? last.parts.findLast((part) => part.type === "thinking")?.id : undefined;
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
            latestThinking={index === messages.length - 1 ? latestThinking : undefined}
          />
        ),
      )}
    </>
  );
}

/**
 * Pending changes grouped by turn, keeping each turn's array identical while
 * its changes are, so replies that didn't change skip re-rendering.
 */
function useStableGroups(hunks: ReadonlyArray<TurnHunk>) {
  const previous = useRef(new Map<string, TurnHunk[]>());
  return useMemo(() => {
    const next = new Map<string, TurnHunk[]>();
    for (const hunk of hunks) {
      if (!hunk.turn) continue;
      const list = next.get(hunk.turn) ?? [];
      list.push(hunk);
      next.set(hunk.turn, list);
    }
    for (const [turn, list] of next) {
      const old = previous.current.get(turn);
      if (old && old.length === list.length && old.every((hunk, i) => hunk.id === list[i]!.id && hunk.insertedText === list[i]!.insertedText && hunk.deletedText === list[i]!.deletedText)) next.set(turn, old);
    }
    previous.current = next;
    return next;
  }, [hunks]);
}

/** "claude-sonnet-5-5" → "Sonnet 5.5"; unknown ids are shown as they are. */
function modelLabel(id: string) {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/.exec(id);
  if (!match) return id;
  const [, family, major, minor] = match;
  return `${family![0]!.toUpperCase()}${family!.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
}

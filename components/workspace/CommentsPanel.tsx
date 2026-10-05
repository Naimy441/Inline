"use client";

import { Check, MessageSquare, MoreHorizontal, RotateCcw, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { del, patch, post } from "@/lib/client/api";
import type { DocumentSession } from "@/lib/client/documentSession";
import type { DocComment } from "@/lib/doc/settings";
import { commentRanges } from "@/lib/editor/comments";
import { IconButton } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";

function when(at: number) {
  const date = new Date(at);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function CommentsPanel({
  session,
  comments,
  active,
  draft,
  onDraftDone,
  onClose,
  onAskClaude,
}: {
  session: DocumentSession;
  comments: DocComment[];
  active: string | null;
  draft: boolean;
  onDraftDone: () => void;
  onClose: () => void;
  onAskClaude: (comment: DocComment) => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const order = useMemo(() => {
    const state = session.view?.state;
    const ranges = state ? commentRanges(state) : new Map<string, { from: number; to: number }>();
    return [...comments]
      .filter((comment) => showResolved || !comment.resolved)
      .sort((a, b) => (ranges.get(a.id)?.from ?? Number.MAX_SAFE_INTEGER) - (ranges.get(b.id)?.from ?? Number.MAX_SAFE_INTEGER));
  }, [comments, showResolved, session]);
  const resolvedCount = comments.filter((comment) => comment.resolved).length;

  return (
    <aside className="side-panel" aria-label="Comments">
      <header className="panel-header">
        <div className="panel-title">
          <span className="panel-title-text">Comments</span>
        </div>
        <div className="panel-actions">
          {resolvedCount > 0 && (
            <button type="button" className="link-btn" onClick={() => setShowResolved((value) => !value)}>
              {showResolved ? "Hide resolved" : `Show resolved (${resolvedCount})`}
            </button>
          )}
          <IconButton label="Close comments" size="sm" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
      </header>
      <div className="panel-scroll comments">
        {draft && <NewComment session={session} onDone={onDraftDone} />}
        {!draft && order.length === 0 && (
          <div className="panel-empty small">
            <MessageSquare size={20} />
            <p>Select text and press the comment button to leave a note. Claude can read and answer comments too.</p>
          </div>
        )}
        {order.map((comment) => (
          <CommentCard
            key={comment.id}
            documentId={session.id}
            comment={comment}
            active={active === comment.id}
            onActivate={() => {
              session.setActiveComment(comment.id);
              const state = session.view?.state;
              const range = state ? commentRanges(state).get(comment.id) : undefined;
              if (range) session.scrollTo(range.from, range.to);
            }}
            onAskClaude={() => onAskClaude(comment)}
          />
        ))}
      </div>
    </aside>
  );
}

function NewComment({ session, onDone }: { session: DocumentSession; onDone: () => void }) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const quote = session.selection()?.text ?? "";
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const save = async () => {
    if (!body.trim()) return;
    setSaving(true);
    try {
      await session.addComment(body.trim());
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add the comment.");
      setSaving(false);
    }
  };
  return (
    <div className="comment-card is-active is-draft">
      {quote && <div className="comment-quote">{quote}</div>}
      <textarea
        ref={ref}
        className="input comment-input"
        rows={3}
        placeholder="Add a comment…"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save();
          if (event.key === "Escape") onDone();
        }}
      />
      {error && <div className="panel-error">{error}</div>}
      <div className="comment-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
          <span className="btn-label">Cancel</span>
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!body.trim() || saving} onClick={() => void save()}>
          <span className="btn-label">Comment</span>
        </button>
      </div>
    </div>
  );
}

function CommentCard({
  documentId,
  comment,
  active,
  onActivate,
  onAskClaude,
}: {
  documentId: string;
  comment: DocComment;
  active: boolean;
  onActivate: () => void;
  onAskClaude: () => void;
}) {
  const [reply, setReply] = useState("");
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const base = `/api/documents/${documentId}/comments/${comment.id}`;
  return (
    <div className={`comment-card${active ? " is-active" : ""}${comment.resolved ? " is-resolved" : ""}`} onClick={onActivate}>
      <div className="comment-head">
        <span className={`avatar ${comment.author === "claude" ? "is-claude" : ""}`}>{comment.author === "claude" ? <Sparkles size={11} /> : "Y"}</span>
        <span className="comment-author">{comment.author === "claude" ? "Claude" : "You"}</span>
        <span className="comment-time">{when(comment.createdAt)}</span>
        <span className="comment-tools">
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label={comment.resolved ? "Reopen" : "Resolve"}
            data-tip={comment.resolved ? "Reopen" : "Resolve"}
            onClick={(event) => {
              event.stopPropagation();
              void patch(base, { resolved: !comment.resolved });
            }}
          >
            {comment.resolved ? <RotateCcw size={14} /> : <Check size={14} />}
          </button>
          <button
            ref={menuRef}
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="More"
            onClick={(event) => {
              event.stopPropagation();
              setMenu(true);
            }}
          >
            <MoreHorizontal size={14} />
          </button>
        </span>
        <Menu
          open={menu}
          onClose={() => setMenu(false)}
          anchor={menuRef}
          placement="bottom-end"
          items={[
            { label: "Ask Claude to address this", icon: <Sparkles size={14} />, onSelect: onAskClaude },
            { kind: "separator" },
            { label: "Delete", icon: <Trash2 size={14} />, danger: true, onSelect: () => void del(base) },
          ]}
        />
      </div>
      {comment.quote && <div className="comment-quote">{comment.quote}</div>}
      <div className="comment-body">{comment.body}</div>
      {comment.replies.map((item) => (
        <div key={item.id} className="comment-reply">
          <div className="comment-head">
            <span className={`avatar ${item.author === "claude" ? "is-claude" : ""}`}>{item.author === "claude" ? <Sparkles size={11} /> : "Y"}</span>
            <span className="comment-author">{item.author === "claude" ? "Claude" : "You"}</span>
            <span className="comment-time">{when(item.createdAt)}</span>
          </div>
          <div className="comment-body">{item.body}</div>
        </div>
      ))}
      {active && !comment.resolved && (
        <div className="comment-reply-box" onClick={(event) => event.stopPropagation()}>
          <input
            className="input"
            placeholder="Reply…"
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && reply.trim()) {
                void post(`${base}/replies`, { body: reply.trim() });
                setReply("");
              }
            }}
          />
        </div>
      )}
    </div>
  );
}

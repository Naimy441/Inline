"use client";

import { Check, MessageSquare, MoreHorizontal, RotateCcw, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";
import type { DocComment } from "@/lib/doc/settings";
import { commentDraft, commentRanges } from "@/lib/editor/comments";
import { IconButton } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { toast } from "@/components/ui/Toast";

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
  /** The text a new comment is being written about, while drafting. */
  draft: { from: number; to: number } | null;
  onDraftDone: () => void;
  onClose: () => void;
  onAskClaude: (comment: DocComment) => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const order = useMemo(() => {
    const state = session.view?.state;
    const ranges = state ? commentRanges(state) : new Map<string, { from: number; to: number }>();
    const at = (comment: DocComment) => ranges.get(comment.id)?.from ?? comment.pending?.from ?? Number.MAX_SAFE_INTEGER;
    return [...comments].filter((comment) => showResolved || !comment.resolved).sort((a, b) => at(a) - at(b));
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
        {draft && <NewComment session={session} range={draft} onDone={onDraftDone} />}
        {!draft && order.length === 0 && (
          <div className="panel-empty small">
            <MessageSquare size={20} />
            <p>Select text and press the comment button to leave a note. Claude can read and answer comments too.</p>
          </div>
        )}
        {order.map((comment) => (
          <CommentCard
            key={comment.id}
            session={session}
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

/** A comment field that grows with its text; Enter sends, Shift+Enter adds a line. */
function CommentField({ placeholder, onSubmit, onCancel, autoFocus = false, submitLabel, initial = "" }: { placeholder: string; onSubmit: (body: string) => void; onCancel?: () => void; autoFocus?: boolean; submitLabel: string; initial?: string }) {
  const [body, setBody] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const focus = () => ref.current?.focus({ preventScroll: true });
    focus();
    // A floating card is hidden until it's placed, and hidden fields can't take focus.
    const frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(220, element.scrollHeight)}px`;
  }, [body]);
  const submit = () => {
    const text = body.trim();
    if (!text) return;
    setBody("");
    onSubmit(text);
  };
  return (
    <div className="comment-field" onClick={(event) => event.stopPropagation()}>
      <textarea
        ref={ref}
        className="comment-input"
        rows={1}
        placeholder={placeholder}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
          if (event.key === "Escape") {
            event.stopPropagation();
            if (body) setBody("");
            else onCancel?.();
          }
        }}
      />
      {(body.trim() || onCancel) && (
        <div className="comment-actions">
          {onCancel && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
              <span className="btn-label">Cancel</span>
            </button>
          )}
          <button type="button" className="btn btn-primary btn-sm" disabled={!body.trim()} onClick={submit}>
            <span className="btn-label">{submitLabel}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Text of a comment that failed to save, offered again in the next draft. */
let unsavedDraft = "";

export function NewComment({ session, range: started, onDone }: { session: DocumentSession; range: { from: number; to: number } | null; onDone: () => void }) {
  // The draft's range follows edits made while the comment is being written.
  const state = session.view?.state;
  const range = (state && commentDraft(state)) ?? (started && state && started.to <= state.doc.content.size ? started : null);
  const quote = range ? (state?.doc.textBetween(range.from, range.to, " ") ?? "") : (session.selection()?.text ?? "");
  const initial = unsavedDraft;
  unsavedDraft = "";
  return (
    <div className="comment-card is-active is-draft">
      <div className="comment-head">
        <span className="avatar">Y</span>
        <span className="comment-author">You</span>
      </div>
      {quote && <div className="comment-quote">{quote}</div>}
      <CommentField
        autoFocus
        initial={initial}
        placeholder="Add a comment…"
        submitLabel="Comment"
        onCancel={onDone}
        onSubmit={(body) => {
          onDone();
          void session.addComment(body, range ?? undefined).catch((error: Error) => {
            unsavedDraft = body;
            toast(`${error.message || "Couldn't add the comment."} Your text is kept for the next try.`, { tone: "error" });
          });
        }}
      />
    </div>
  );
}

export function CommentCard({
  session,
  comment,
  active,
  onActivate,
  onAskClaude,
}: {
  session: DocumentSession;
  comment: DocComment;
  active: boolean;
  onActivate: () => void;
  onAskClaude: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const failed = (error: Error) => toast(error.message || "Couldn't save that change.", { tone: "error" });
  return (
    <div className={`comment-card${active ? " is-active" : ""}${comment.resolved ? " is-resolved" : ""}${comment.pending ? " is-pending" : ""}`} onClick={onActivate}>
      <div className="comment-head">
        <span className={`avatar ${comment.author === "claude" ? "is-claude" : ""}`}>{comment.author === "claude" ? <Sparkles size={11} /> : "Y"}</span>
        <span className="comment-author">{comment.author === "claude" ? "Claude" : "You"}</span>
        <span className="comment-time">{comment.pending ? "Saving…" : when(comment.createdAt)}</span>
        {!comment.pending && (
          <span className="comment-tools">
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label={comment.resolved ? "Reopen" : "Resolve"}
              data-tip={comment.resolved ? "Reopen" : "Resolve"}
              onClick={(event) => {
                event.stopPropagation();
                void session.resolveComment(comment.id, !comment.resolved).catch(failed);
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
        )}
        <Menu
          open={menu}
          onClose={() => setMenu(false)}
          anchor={menuRef}
          placement="bottom-end"
          items={[
            { label: "Ask Claude to address this", icon: <Sparkles size={14} />, onSelect: onAskClaude },
            { kind: "separator" },
            { label: "Delete", icon: <Trash2 size={14} />, danger: true, onSelect: () => void session.deleteComment(comment.id).catch(failed) },
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
            <span className="comment-time">{item.id.startsWith("pending-") ? "Saving…" : when(item.createdAt)}</span>
          </div>
          <div className="comment-body">{item.body}</div>
        </div>
      ))}
      {active && !comment.resolved && !comment.pending && (
        <div className="comment-reply-box">
          <CommentField placeholder="Reply…" submitLabel="Reply" onSubmit={(body) => void session.replyToComment(comment.id, body).catch(failed)} />
        </div>
      )}
    </div>
  );
}

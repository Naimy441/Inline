"use client";

import { useState } from "react";

export type DocComment = {
  id: string;
  quote: string;
  body: string;
};

type Props = {
  comments: DocComment[];
  minimized: boolean;
  busy?: boolean;
  onMinimizedChange: (value: boolean) => void;
  onChange: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onJump: (id: string) => void;
  onAddress: (comments: DocComment[]) => void;
};

export function CommentsPanel({
  comments,
  minimized,
  busy,
  onMinimizedChange,
  onChange,
  onDelete,
  onJump,
  onAddress,
}: Props) {
  const [selected, setSelected] = useState<string[]>([]);

  if (minimized) {
    return (
      <aside className="comments-rail">
        <button type="button" className="comments-rail-btn" onClick={() => onMinimizedChange(false)}>
          Comments ({comments.length})
        </button>
      </aside>
    );
  }

  const toggle = (id: string) => {
    setSelected((list) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]));
  };

  const chosen = comments.filter((comment) => selected.includes(comment.id));

  return (
    <aside className="comments-panel">
      <div className="comments-head">
        <strong>Comments</strong>
        <button type="button" className="dialog-text-btn" onClick={() => onMinimizedChange(true)}>
          Minimize
        </button>
      </div>
      {comments.length === 0 ? (
        <p className="comments-empty">Select text, then Insert a comment from View or the shortcut.</p>
      ) : (
        <ul className="comments-list">
          {comments.map((comment) => (
            <li key={comment.id} className="comment-card">
              <label className="comment-select">
                <input
                  type="checkbox"
                  checked={selected.includes(comment.id)}
                  onChange={() => toggle(comment.id)}
                />
                Address
              </label>
              <button type="button" className="comment-quote" onClick={() => onJump(comment.id)}>
                {comment.quote}
              </button>
              <textarea
                value={comment.body}
                rows={3}
                onChange={(event) => onChange(comment.id, event.target.value)}
                placeholder="Write a comment"
              />
              <button type="button" className="dialog-text-btn" onClick={() => onDelete(comment.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {comments.length > 0 && (
        <div className="comment-address">
          <button
            type="button"
            disabled={busy || chosen.length === 0}
            onClick={() => onAddress(chosen)}
          >
            Address selected
          </button>
          <button type="button" className="chat-review-primary" disabled={busy} onClick={() => onAddress(comments)}>
            Address all
          </button>
        </div>
      )}
    </aside>
  );
}

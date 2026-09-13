"use client";

export type DocComment = {
  id: string;
  quote: string;
  body: string;
};

type Props = {
  comments: DocComment[];
  minimized: boolean;
  onMinimizedChange: (value: boolean) => void;
  onChange: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onJump: (id: string) => void;
};

export function CommentsPanel({
  comments,
  minimized,
  onMinimizedChange,
  onChange,
  onDelete,
  onJump,
}: Props) {
  if (minimized) {
    return (
      <aside className="comments-rail">
        <button type="button" className="comments-rail-btn" onClick={() => onMinimizedChange(false)}>
          Comments ({comments.length})
        </button>
      </aside>
    );
  }

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
    </aside>
  );
}

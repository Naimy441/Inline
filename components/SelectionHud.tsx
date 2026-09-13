"use client";

type Props = {
  box: { top: number; left: number; width: number };
  locked: boolean;
  onEdit: () => void;
  onAsk: () => void;
  onComment: () => void;
  onLock: () => void;
};

export function SelectionHud({ box, locked, onEdit, onAsk, onComment, onLock }: Props) {
  const left = Math.min(Math.max(12, box.left), window.innerWidth - 320);
  const top = Math.max(12, box.top - 44);
  return (
    <div className="sel-hud" style={{ top, left }}>
      <button type="button" onClick={onEdit}>
        Edit <kbd>⌘K</kbd>
      </button>
      <button type="button" onClick={onAsk}>
        Ask
      </button>
      <button type="button" onClick={onComment}>
        Comment
      </button>
      <button type="button" data-active={locked} onClick={onLock}>
        {locked ? "Unlock" : "Lock"}
      </button>
    </div>
  );
}

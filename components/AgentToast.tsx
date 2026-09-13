"use client";

type Props = {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
};

export function AgentToast({ text, actionLabel, onAction, onDismiss }: Props) {
  return (
    <div className="agent-toast">
      <p>{text}</p>
      {actionLabel && onAction ? (
        <button type="button" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
      <button type="button" className="agent-toast-x" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

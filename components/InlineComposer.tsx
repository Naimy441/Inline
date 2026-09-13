"use client";

import { useEffect, useRef } from "react";

type Props = {
  box: { top: number; left: number; width: number };
  prompt: string;
  busy: boolean;
  preserveTone: boolean;
  onPromptChange: (value: string) => void;
  onPreserveToneChange: (value: boolean) => void;
  onSubmit: () => void;
  onOpenChat: () => void;
  onClose: () => void;
};

export function InlineComposer({
  box,
  prompt,
  busy,
  preserveTone,
  onPromptChange,
  onPreserveToneChange,
  onSubmit,
  onOpenChat,
  onClose,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const width = Math.min(420, Math.max(320, box.width + 40));
  const left = Math.min(Math.max(12, box.left), window.innerWidth - width - 12);
  const top = Math.min(box.top + 10, window.innerHeight - 180);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <form
      className="inline-composer"
      style={{ top, left, width }}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <textarea
        ref={inputRef}
        rows={2}
        value={prompt}
        placeholder="Edit this passage…"
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="inline-composer-bar">
        <button
          type="button"
          className="inline-chip"
          data-active={preserveTone}
          onClick={() => onPreserveToneChange(!preserveTone)}
        >
          Preserve tone
        </button>
        <button type="button" className="inline-chip" onClick={onOpenChat}>
          Open chat
        </button>
        <span className="inline-spacer" />
        <button type="button" className="inline-chip" onClick={onClose}>
          Esc
        </button>
        <button type="submit" className="inline-send" disabled={busy || !prompt.trim()}>
          {busy ? "…" : "⌘↵"}
        </button>
      </div>
    </form>
  );
}

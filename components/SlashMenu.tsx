"use client";

import { PROMPT_TEMPLATES } from "@/lib/writing/templates";

type Props = {
  query: string;
  box: { top: number; left: number };
  onPick: (id: string) => void;
  onClose: () => void;
};

export function SlashMenu({ query, box, onPick, onClose }: Props) {
  const q = query.toLowerCase();
  const items = PROMPT_TEMPLATES.filter((item) => !q || item.label.toLowerCase().includes(q) || item.id.includes(q));
  if (!items.length) return null;
  return (
    <div className="slash-menu" style={{ top: box.top, left: box.left }} onMouseDown={(event) => event.stopPropagation()}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => {
            onPick(item.id);
            onClose();
          }}
        >
          <strong>/{item.label}</strong>
          <span>{item.hint}</span>
        </button>
      ))}
    </div>
  );
}

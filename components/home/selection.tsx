"use client";

import { Check } from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { DragItem } from "./dnd";

/**
 * Picking several documents and folders on the home page. Shift-, Cmd- or
 * Ctrl-click (or the round check on a card) adds an item; once anything is
 * picked, plain clicks pick too, until the selection is cleared.
 */
export type Selection = {
  active: boolean;
  has: (kind: DragItem["kind"], id: string) => boolean;
  toggle: (item: DragItem) => void;
  /** Everything picked, for dragging them together. */
  items: DragItem[];
};

/** Click and Enter handlers for an item: pick it when selecting, otherwise open it. */
export function itemHandlers(selection: Selection | undefined, item: DragItem, open: () => void) {
  const picking = (event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => Boolean(selection && (selection.active || event.shiftKey || event.metaKey || event.ctrlKey));
  return {
    onClick: (event: MouseEvent) => {
      if (picking(event)) {
        event.preventDefault();
        selection!.toggle(item);
      } else open();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter") {
        if (picking(event)) selection!.toggle(item);
        else open();
      } else if (event.key === " " && selection) {
        event.preventDefault();
        selection.toggle(item);
      }
    },
  };
}

/** The round check in a card's corner: shows on hover, and stays once anything is picked. */
export function SelectCheck({ selection, item, inline = false }: { selection: Selection | undefined; item: DragItem; inline?: boolean }) {
  if (!selection) return null;
  const selected = selection.has(item.kind, item.id);
  return (
    <button
      type="button"
      className={`select-check${inline ? " is-inline" : ""}${selected ? " is-checked" : ""}${selection.active ? " is-visible" : ""}`}
      aria-label={`${selected ? "Deselect" : "Select"} ${item.title}`}
      aria-pressed={selected}
      onClick={(event) => {
        event.stopPropagation();
        selection.toggle(item);
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Check size={12} strokeWidth={3} />
    </button>
  );
}

"use client";

import { useRef, useState, type DragEvent } from "react";

/**
 * Drag and drop for the home page: documents and folders drag onto folders
 * (cards, rows and breadcrumb steps). What's being dragged is kept here as
 * well as in the drag data, because drag-over events can't read the data and
 * need it to decide whether a drop is allowed.
 */

export type DragItem = { kind: "document" | "folder"; id: string; title: string };

const TYPE = "application/x-inline-item";
let current: DragItem | null = null;

export function dragSource(item: DragItem, enabled = true) {
  if (!enabled) return {};
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      current = item;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(TYPE, JSON.stringify(item));
      event.dataTransfer.setData("text/plain", item.title);
      (event.currentTarget as HTMLElement).classList.add("is-dragging");
    },
    onDragEnd: (event: DragEvent) => {
      current = null;
      (event.currentTarget as HTMLElement).classList.remove("is-dragging");
    },
  };
}

/** Props that make an element accept drops, and whether something is hovering over it now. */
export function useDropTarget(accepts: (item: DragItem) => boolean, onDrop: (item: DragItem) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const allowed = (event: DragEvent) => Boolean(current) && event.dataTransfer.types.includes(TYPE) && accepts(current!);
  return {
    over,
    props: {
      onDragEnter: (event: DragEvent) => {
        if (!allowed(event)) return;
        event.preventDefault();
        depth.current += 1;
        setOver(true);
      },
      onDragOver: (event: DragEvent) => {
        if (!allowed(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      },
      onDrop: (event: DragEvent) => {
        depth.current = 0;
        setOver(false);
        const item = current;
        current = null;
        if (!item || !accepts(item)) return;
        event.preventDefault();
        onDrop(item);
      },
    },
  };
}

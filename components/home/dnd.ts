"use client";

import { useRef, useState, type DragEvent } from "react";

/**
 * Drag and drop for the home page: documents and folders drag onto folders
 * (cards, rows and breadcrumb steps). Dragging something that's part of a
 * selection carries the whole selection. What's being dragged is kept here as
 * well as in the drag data, because drag-over events can't read the data and
 * need it to decide whether a drop is allowed.
 */

export type DragItem = { kind: "document" | "folder"; id: string; title: string };

const TYPE = "application/x-inline-item";
let current: DragItem[] = [];

const same = (a: DragItem, b: DragItem) => a.kind === b.kind && a.id === b.id;

/** Props that make an element draggable. `group` is the selection: dragging one of its items drags them all. */
export function dragSource(item: DragItem, enabled = true, group: DragItem[] = []) {
  if (!enabled) return {};
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      current = group.length > 1 && group.some((entry) => same(entry, item)) ? group : [item];
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(TYPE, JSON.stringify(current));
      event.dataTransfer.setData("text/plain", current.map((entry) => entry.title).join("\n"));
      (event.currentTarget as HTMLElement).classList.add("is-dragging");
    },
    onDragEnd: (event: DragEvent) => {
      current = [];
      (event.currentTarget as HTMLElement).classList.remove("is-dragging");
    },
  };
}

/**
 * Props that make an element accept drops, and whether something is hovering
 * over it now. A drop is allowed when any dragged item can go there; only
 * those items are handed to `onDrop`.
 */
export function useDropTarget(accepts: (item: DragItem) => boolean, onDrop: (items: DragItem[]) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const allowed = (event: DragEvent) => current.length > 0 && event.dataTransfer.types.includes(TYPE) && current.some(accepts);
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
        const items = current.filter(accepts);
        current = [];
        if (!items.length) return;
        event.preventDefault();
        onDrop(items);
      },
    },
  };
}

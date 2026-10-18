import { closeHistory } from "prosemirror-history";
import { TextSelection, Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

/** A top-level canvas block, measured in the document and on screen. */
export type BlockSlot = { pos: number; size: number; top: number; bottom: number; left: number };

/**
 * Where a dragged block should land. `y` is compared with each block's midpoint,
 * so the drop is the gap before the block whose middle the pointer has not passed.
 * The block's own span is not a destination.
 */
export function blockDropDest(slots: BlockSlot[], y: number, from: number, draggedSize: number): number | null {
  if (!slots.length || draggedSize <= 0) return null;
  let dest = slots[slots.length - 1].pos + slots[slots.length - 1].size;
  for (const slot of slots) {
    if (y < (slot.top + slot.bottom) / 2) {
      dest = slot.pos;
      break;
    }
  }
  if (dest === from || dest === from + draggedSize) return null;
  return dest;
}

/** Notion-style drag handle for the blocks of a canvas. */
export function canvasBlockHandlesPlugin() {
  return new Plugin({
    view(view) {
      const layer = document.createElement("div");
      layer.className = "canvas-block-handles";
      layer.hidden = true;
      const bar = document.createElement("div");
      bar.className = "canvas-block-handle";
      const grip = document.createElement("button");
      grip.type = "button";
      grip.dataset.handle = "drag";
      grip.setAttribute("aria-label", "Drag block");
      grip.textContent = "⋮⋮";
      bar.append(grip);
      layer.append(bar);
      let block: HTMLElement | null = null;
      let hideTimer = 0;
      let dragging = false;
      let caret: HTMLElement | null = null;

      const stackOf = () => (view.dom.closest(".page-stack") as HTMLElement | null) ?? view.dom.parentElement;
      const mount = () => {
        const stack = stackOf();
        if (stack && layer.parentElement !== stack) stack.append(layer);
      };
      const cancelHide = () => {
        if (hideTimer) window.clearTimeout(hideTimer);
        hideTimer = 0;
      };
      const hideCaret = () => {
        if (caret) caret.hidden = true;
      };
      const hide = () => {
        block = null;
        bar.classList.remove("is-on");
        hideCaret();
      };
      const hideSoon = () => {
        cancelHide();
        hideTimer = window.setTimeout(hide, 160);
      };
      const place = (target: HTMLElement) => {
        const stack = stackOf();
        if (!stack) return;
        mount();
        const scale = stack.offsetWidth > 0 ? stack.getBoundingClientRect().width / stack.offsetWidth : 1;
        const stackBox = stack.getBoundingClientRect();
        const box = target.getBoundingClientRect();
        const top = (box.top - stackBox.top) / (scale || 1);
        const left = (box.left - stackBox.left) / (scale || 1);
        bar.classList.add("is-on");
        bar.style.top = `${top}px`;
        bar.style.left = `${Math.max(0, left - 28)}px`;
        layer.hidden = false;
      };
      const show = (target: HTMLElement) => {
        if (!view.editable || !view.state.doc.attrs.canvas || dragging) return;
        if (blockPos(view, target) == null) return;
        cancelHide();
        block = target;
        place(target);
      };
      const endDrag = () => {
        dragging = false;
        layer.classList.remove("is-dragging");
        document.documentElement.classList.remove("canvas-block-dragging");
        hideCaret();
      };

      grip.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || !block || !view.editable) return;
        const from = blockPos(view, block);
        const dragged = from == null ? null : view.state.doc.nodeAt(from);
        if (from == null || !dragged) return;
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const startY = event.clientY;
        let moved = false;
        const move = (ev: PointerEvent) => {
          if (view.isDestroyed) {
            finish(ev);
            return;
          }
          if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
          if (!moved) {
            moved = true;
            dragging = true;
            layer.classList.add("is-dragging");
            document.documentElement.classList.add("canvas-block-dragging");
            bar.classList.remove("is-on");
          }
          const target = dropTarget(view, ev.clientX, ev.clientY, from, dragged.nodeSize);
          if (!target) {
            hideCaret();
            return;
          }
          showBlockCaret(view, target);
        };
        const finish = (ev: PointerEvent) => {
          window.removeEventListener("pointermove", move, true);
          window.removeEventListener("pointerup", up, true);
          window.removeEventListener("pointercancel", up, true);
          const target = moved && !view.isDestroyed ? dropTarget(view, ev.clientX, ev.clientY, from, dragged.nodeSize) : null;
          endDrag();
          hide();
          if (target) moveTopBlock(view, from, target.dest);
        };
        const up = (ev: PointerEvent) => {
          ev.preventDefault();
          ev.stopPropagation();
          finish(ev);
        };
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", up, true);
        window.addEventListener("pointercancel", up, true);
      });

      const onDocMove = (event: PointerEvent) => {
        if (dragging) return;
        const target = event.target;
        if (target instanceof Node && layer.contains(target)) {
          cancelHide();
          return;
        }
        const next = topBlock(view, target);
        if (next) show(next);
        else hideSoon();
      };
      document.addEventListener("pointermove", onDocMove);

      const showBlockCaret = (editor: EditorView, target: DropTarget) => {
        caret = blockDropCaret();
        const pos = Math.max(0, Math.min(editor.state.doc.content.size, target.dest));
        let left = target.left - 1;
        let height = 22;
        try {
          const coords = editor.coordsAtPos(pos, pos < editor.state.doc.content.size ? 1 : -1);
          if (coords.left) left = coords.left - 1;
          const line = coords.bottom - coords.top;
          if (line > 8) height = Math.max(18, Math.min(28, line));
        } catch {
          // The boundary still has a measured edge when the position has no coords.
        }
        caret.hidden = false;
        caret.style.height = `${height}px`;
        caret.style.top = `${target.edge - height / 2}px`;
        caret.style.left = `${left}px`;
      };

      return {
        update: () => {
          if (!view.state.doc.attrs.canvas || !view.editable) {
            layer.hidden = true;
            if (!dragging) hideCaret();
            return;
          }
          mount();
          if (dragging) return;
          if (block?.isConnected) place(block);
          else hide();
        },
        destroy: () => {
          cancelHide();
          endDrag();
          document.removeEventListener("pointermove", onDocMove);
          layer.remove();
        },
      };
    },
  });
}

function blockDropCaret() {
  let el = document.querySelector<HTMLElement>(".image-drop-caret");
  if (!el) {
    el = document.createElement("div");
    el.className = "image-drop-caret";
    el.setAttribute("aria-hidden", "true");
    el.hidden = true;
    document.body.append(el);
  }
  return el;
}

function topBlock(view: EditorView, target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Node) || !view.dom.contains(target)) return null;
  let node: Node | null = target;
  while (node && node.parentNode !== view.dom) node = node.parentNode;
  if (!(node instanceof HTMLElement) || node.classList.contains("page-gap")) return null;
  return node;
}

function blockPos(view: EditorView, block: HTMLElement): number | null {
  try {
    const found = view.posAtDOM(block, 0);
    const $pos = view.state.doc.resolve(Math.max(0, Math.min(view.state.doc.content.size, found)));
    if ($pos.depth < 1) {
      const node = view.state.doc.nodeAt($pos.pos);
      return node ? $pos.pos : null;
    }
    return $pos.before(1);
  } catch {
    return null;
  }
}

type DropTarget = { dest: number; edge: number; left: number };

function dropTarget(view: EditorView, x: number, y: number, from: number, draggedSize: number): DropTarget | null {
  const stack = (view.dom.closest(".page-stack") as HTMLElement | null) ?? view.dom;
  const box = stack.getBoundingClientRect();
  if (x < box.left - 64 || x > box.right + 32 || y < box.top - 32 || y > box.bottom + 32) return null;
  const slots = topSlots(view);
  const dest = blockDropDest(slots, y, from, draggedSize);
  if (dest == null) return null;
  const slot = slots.find((item) => item.pos === dest);
  const last = slots[slots.length - 1];
  if (!last) return null;
  return { dest, edge: slot ? slot.top : last.bottom, left: (slot ?? last).left };
}

function topSlots(view: EditorView): BlockSlot[] {
  const slots: BlockSlot[] = [];
  for (const child of Array.from(view.dom.children)) {
    if (!(child instanceof HTMLElement) || child.classList.contains("page-gap")) continue;
    const pos = blockPos(view, child);
    const node = pos == null ? null : view.state.doc.nodeAt(pos);
    if (pos == null || !node?.isBlock) continue;
    const rect = child.getBoundingClientRect();
    if (rect.height < 1) continue;
    slots.push({ pos, size: node.nodeSize, top: rect.top, bottom: rect.bottom, left: rect.left });
  }
  slots.sort((a, b) => a.top - b.top || a.pos - b.pos);
  return slots;
}

function moveTopBlock(view: EditorView, from: number, to: number) {
  const node = view.state.doc.nodeAt(from);
  if (!node) return;
  const tr = closeHistory(view.state.tr);
  tr.delete(from, from + node.nodeSize);
  const dest = tr.mapping.map(to);
  if (dest < 0 || dest > tr.doc.content.size) return;
  tr.insert(dest, node);
  const caret = Math.min(dest + 1, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(caret)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

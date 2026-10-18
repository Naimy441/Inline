import { closeHistory } from "prosemirror-history";
import { TextSelection, Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { schema } from "@/lib/doc/schema";

/** Notion-style handles for the blocks of a canvas: add below, or drag to reorder. */
export function canvasBlockHandlesPlugin() {
  return new Plugin({
    view(view) {
      const layer = document.createElement("div");
      layer.className = "canvas-block-handles";
      layer.hidden = true;
      const bar = document.createElement("div");
      bar.className = "canvas-block-handle";
      const add = document.createElement("button");
      add.type = "button";
      add.dataset.handle = "add";
      add.setAttribute("aria-label", "Add block");
      add.textContent = "+";
      const grip = document.createElement("button");
      grip.type = "button";
      grip.dataset.handle = "drag";
      grip.setAttribute("aria-label", "Drag block");
      grip.textContent = "⋮⋮";
      const line = document.createElement("div");
      line.className = "canvas-block-drop";
      line.hidden = true;
      bar.append(add, grip);
      layer.append(bar, line);
      let block: HTMLElement | null = null;
      let hideTimer = 0;
      let dragging = false;

      const stackOf = () => (view.dom.closest(".page-stack") as HTMLElement | null) ?? view.dom.parentElement;
      const mount = () => {
        const stack = stackOf();
        if (stack && layer.parentElement !== stack) stack.append(layer);
      };
      const cancelHide = () => {
        if (hideTimer) window.clearTimeout(hideTimer);
        hideTimer = 0;
      };
      const hide = () => {
        block = null;
        bar.classList.remove("is-on");
        line.hidden = true;
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
        bar.style.left = `${Math.max(0, left - 52)}px`;
        layer.hidden = false;
      };
      const show = (target: HTMLElement) => {
        if (!view.editable || !view.state.doc.attrs.canvas || dragging) return;
        if (blockPos(view, target) == null) return;
        cancelHide();
        block = target;
        place(target);
      };

      add.addEventListener("mousedown", (event) => event.preventDefault());
      add.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!block || !view.editable) return;
        const start = blockPos(view, block);
        const node = start == null ? null : view.state.doc.nodeAt(start);
        if (start == null || !node) return;
        const at = start + node.nodeSize;
        const paragraph = schema.nodes.paragraph.create();
        let tr = closeHistory(view.state.tr).insert(at, paragraph);
        tr = tr.setSelection(TextSelection.create(tr.doc, at + 1));
        view.dispatch(tr.scrollIntoView());
        view.focus();
        hide();
      });

      grip.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || !block || !view.editable) return;
        const from = blockPos(view, block);
        if (from == null) return;
        grip.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
        dragging = true;
        layer.classList.add("is-dragging");
        bar.style.pointerEvents = "none";
        const move = (ev: PointerEvent) => {
          const dest = dropAt(view, ev.clientX, ev.clientY, from);
          const stack = stackOf();
          if (dest == null || !stack) {
            line.hidden = true;
            return;
          }
          const scale = stack.offsetWidth > 0 ? stack.getBoundingClientRect().width / stack.offsetWidth : 1;
          const stackBox = stack.getBoundingClientRect();
          const under = document.elementFromPoint(ev.clientX, ev.clientY);
          const target = topBlock(view, under);
          if (!target) {
            line.hidden = true;
            return;
          }
          const box = target.getBoundingClientRect();
          const after = ev.clientY > box.top + box.height / 2;
          const y = ((after ? box.bottom : box.top) - stackBox.top) / (scale || 1);
          const left = (box.left - stackBox.left) / (scale || 1);
          line.hidden = false;
          line.style.top = `${y}px`;
          line.style.left = `${left}px`;
          line.style.width = `${box.width / (scale || 1)}px`;
        };
        const up = (ev: PointerEvent) => {
          grip.removeEventListener("pointermove", move);
          grip.removeEventListener("pointerup", up);
          dragging = false;
          layer.classList.remove("is-dragging");
          bar.style.pointerEvents = "";
          line.hidden = true;
          const dest = dropAt(view, ev.clientX, ev.clientY, from);
          if (dest != null && Math.hypot(ev.clientX - event.clientX, ev.clientY - event.clientY) > 4) moveTopBlock(view, from, dest);
          hide();
        };
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", up);
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

      return {
        update: () => {
          if (!view.state.doc.attrs.canvas || !view.editable) {
            layer.hidden = true;
            return;
          }
          mount();
          if (block?.isConnected) place(block);
          else hide();
        },
        destroy: () => {
          cancelHide();
          document.removeEventListener("pointermove", onDocMove);
          layer.remove();
        },
      };
    },
  });
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

function dropAt(view: EditorView, x: number, y: number, from: number): number | null {
  const target = topBlock(view, document.elementFromPoint(x, y));
  if (!target) return null;
  const start = blockPos(view, target);
  const node = start == null ? null : view.state.doc.nodeAt(start);
  if (start == null || !node) return null;
  const box = target.getBoundingClientRect();
  const dest = y > box.top + box.height / 2 ? start + node.nodeSize : start;
  const dragged = view.state.doc.nodeAt(from);
  if (!dragged || dest === from || dest === from + dragged.nodeSize) return null;
  return dest;
}

function moveTopBlock(view: EditorView, from: number, to: number) {
  const node = view.state.doc.nodeAt(from);
  if (!node) return;
  const tr = closeHistory(view.state.tr);
  tr.delete(from, from + node.nodeSize);
  const dest = tr.mapping.map(to);
  tr.insert(dest, node);
  const caret = Math.min(dest + 1, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(caret)));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

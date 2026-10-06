import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";

const MIN_WIDTH = 48;

/** Decodes a base64 data: URL (fetch() on data: URLs is blocked by the page's CSP). */
export function dataUrlToBlob(src: string): Blob | null {
  const match = /^data:([\w.+-]+\/[\w.+-]+)(?:;[^,;]*)*;base64,(.*)$/s.exec(src);
  if (!match) return null;
  const binary = atob(match[2]!.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] });
}


/** Width in px for a drag that started at `startWidth`, kept between MIN_WIDTH and the page width. */
export function resizedWidth(startWidth: number, dx: number, maxWidth: number, side: "left" | "right" = "right") {
  const width = startWidth + (side === "right" ? dx : -dx);
  return Math.round(Math.max(MIN_WIDTH, Math.min(maxWidth, width)));
}

/**
 * Images with resize handles: when the image is selected, dragging a corner
 * handle changes its width (one undoable step, saved as px).
 */
export class ImageView implements NodeView {
  dom: HTMLElement;
  private img: HTMLImageElement;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement("figure");
    this.img = document.createElement("img");
    this.img.draggable = false;
    // The frame hugs the image so the handles sit on its corners.
    const frame = document.createElement("span");
    frame.className = "image-frame";
    frame.append(this.img);
    this.dom.append(frame);
    for (const side of ["left", "right"] as const) {
      const handle = document.createElement("span");
      handle.className = `image-handle image-handle-${side}`;
      handle.setAttribute("aria-hidden", "true");
      handle.addEventListener("pointerdown", (event) => this.startResize(event, side));
      frame.append(handle);
    }
    this.render();
  }

  private render() {
    const { attrs } = this.node;
    // Toggle only our own classes: decorations (review highlights, selection) add theirs to the same element.
    this.dom.classList.add("doc-image");
    for (const align of ["left", "center", "right", "justify"]) this.dom.classList.toggle(`align-${align}`, attrs.align === align);
    if (attrs.id) this.dom.dataset.id = attrs.id;
    if (this.img.getAttribute("src") !== attrs.src) this.img.src = attrs.src;
    this.img.alt = attrs.alt;
    if (attrs.title) this.img.title = attrs.title;
    else this.img.removeAttribute("title");
    this.img.style.width = attrs.width ?? "";
  }

  private startResize(event: PointerEvent, side: "left" | "right") {
    if (!this.view.editable) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = this.img.getBoundingClientRect().width;
    const maxWidth = this.dom.getBoundingClientRect().width || startWidth;
    let width = startWidth;
    this.dom.classList.add("is-resizing");
    const move = (moveEvent: PointerEvent) => {
      width = resizedWidth(startWidth, moveEvent.clientX - startX, maxWidth, side);
      this.img.style.width = `${width}px`;
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      this.dom.classList.remove("is-resizing");
      const pos = this.getPos();
      if (pos === undefined || Math.abs(width - startWidth) < 2) {
        this.render();
        return;
      }
      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, width: `${width}px` }));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  selectNode() {
    this.dom.classList.add("ProseMirror-selectednode");
  }

  deselectNode() {
    this.dom.classList.remove("ProseMirror-selectednode");
  }

  stopEvent(event: Event) {
    return (event.target as HTMLElement).classList?.contains("image-handle") ?? false;
  }

  ignoreMutation() {
    return true;
  }
}

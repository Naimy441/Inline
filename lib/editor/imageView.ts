import { GapCursor } from "prosemirror-gapcursor";
import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection, Plugin, Selection, type EditorState } from "prosemirror-state";
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

const PHOTO_TYPES = new Set(["image", "inline_image"]);

function isPhotoSelection(state: EditorState): state is EditorState & { selection: NodeSelection } {
  return state.selection instanceof NodeSelection && PHOTO_TYPES.has(state.selection.node.type.name);
}

/** The pointer is on the photo or a resize handle, not the block around it. */
function eventOnPhoto(target: EventTarget | null): boolean {
  const element =
    target && typeof target === "object" && "closest" in target && typeof (target as Element).closest === "function"
      ? (target as Element)
      : target && typeof target === "object" && "parentElement" in target
        ? ((target as Node).parentElement ?? null)
        : null;
  return Boolean(element?.closest("img, .image-handle"));
}

/**
 * A cursor that is not the photo. Text beside it when there is any, otherwise
 * a gap cursor (a document that is only a photo has nowhere else to put one).
 */
function cursorOffImage(state: EditorState, imagePos: number): Selection | null {
  const before = Selection.findFrom(state.doc.resolve(imagePos), -1, true);
  if (before) return before;
  const node = state.doc.nodeAt(imagePos);
  const afterPos = imagePos + (node?.nodeSize ?? 1);
  const after = afterPos <= state.doc.content.size ? Selection.findFrom(state.doc.resolve(afterPos), 1, true) : null;
  if (after) return after;
  // `valid` is runtime API; the type marks it internal.
  const gap = GapCursor as unknown as { valid($pos: ReturnType<EditorState["doc"]["resolve"]>): boolean };
  const $at = state.doc.resolve(imagePos);
  if (gap.valid($at)) return new GapCursor($at);
  const $after = state.doc.resolve(Math.min(state.doc.content.size, afterPos));
  return gap.valid($after) ? new GapCursor($after) : null;
}

function moveCursorOffPhoto(view: EditorView, imagePos: number) {
  if (view.isDestroyed) return false;
  const next = cursorOffImage(view.state, imagePos);
  if (!next || next.eq(view.state.selection)) return false;
  view.dispatch(view.state.tr.setSelection(next).setMeta("pointer", true));
  return true;
}

/** A click outside the editor does not update ProseMirror's click tracker, so the next click on the photo would count as a double-click and not select it. */
function forgetRecentClick(view: EditorView) {
  const input = (view as unknown as { input?: { lastClick?: { time: number } } }).input;
  if (input?.lastClick) input.lastClick.time = 0;
}

/**
 * Node selections stay visible when the editor blurs, so a click on the page
 * or the app background would leave a photo selected. Clicks on the photo
 * (and its resize handles) still select it. Clicks inside the document are
 * left to ProseMirror, which places the text caret.
 */
export function imageSelectionPlugin() {
  return new Plugin({
    props: {
      handleClickOn(view, _pos, node, nodePos, event) {
        // Right-click keeps the editor's own menu; shift-click still extends a text selection.
        if (event.button !== 0 || event.shiftKey) return false;
        if (!PHOTO_TYPES.has(node.type.name) || eventOnPhoto(event.target)) return false;
        return moveCursorOffPhoto(view, nodePos);
      },
    },
    view(editorView) {
      const onClick = (event: Event) => {
        if (!("button" in event) || (event as MouseEvent).button !== 0) return;
        if (!isPhotoSelection(editorView.state)) return;
        const target = event.target;
        if (target && typeof (target as Node).nodeType === "number" && editorView.dom.contains(target as Node)) return;
        if (!moveCursorOffPhoto(editorView, editorView.state.selection.from)) return;
        forgetRecentClick(editorView);
      };
      editorView.root.addEventListener("click", onClick);
      return { destroy: () => editorView.root.removeEventListener("click", onClick) };
    },
  });
}

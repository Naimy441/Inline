import { GapCursor } from "prosemirror-gapcursor";
import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection, Plugin, Selection, type EditorState } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import { croppedFrame, cropToken, cssPx, pictureCrop, pictureRotate, pictureWrap } from "@/lib/doc/picture";

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
    // A crop needs the natural size to place the window. An uncropped picture
    // already has its width, and rendering again would wipe a drag in progress.
    this.img.addEventListener("load", () => {
      if (pictureCrop(this.node.attrs.crop)) this.render();
    });
    // The frame hugs the image so the handles sit on its corners. Crop clips inside it; rotation turns that window.
    this.frame = document.createElement("span");
    this.frame.className = "image-frame";
    this.turn = document.createElement("span");
    this.turn.className = "image-turn";
    this.cropBox = document.createElement("span");
    this.cropBox.className = "image-crop";
    this.cropBox.append(this.img);
    this.turn.append(this.cropBox);
    this.frame.append(this.turn);
    this.dom.append(this.frame);
    for (const side of ["left", "right"] as const) {
      const handle = document.createElement("span");
      handle.className = `image-handle image-handle-${side}`;
      handle.setAttribute("aria-hidden", "true");
      handle.addEventListener("pointerdown", (event) => this.startResize(event, side));
      this.frame.append(handle);
    }
    this.render();
  }

  private frame: HTMLElement;
  private turn: HTMLElement;
  private cropBox: HTMLElement;

  private render() {
    const { attrs } = this.node;
    const wrap = pictureWrap(attrs.wrap);
    const crop = pictureCrop(attrs.crop);
    const rotate = pictureRotate(attrs.rotate);
    // Toggle only our own classes: decorations (review highlights, selection) add theirs to the same element.
    this.dom.classList.add("doc-image");
    for (const align of ["left", "center", "right", "justify"]) this.dom.classList.toggle(`align-${align}`, attrs.align === align);
    for (const kind of ["square", "behind", "front"] as const) this.dom.classList.toggle(`wrap-${kind}`, wrap === kind);
    this.dom.classList.toggle("is-cropped", Boolean(crop));
    if (attrs.id) this.dom.dataset.id = attrs.id;
    setData(this.dom, "wrap", wrap);
    setData(this.dom, "crop", crop ? cropToken(crop) : null);
    setData(this.dom, "rotate", rotate != null ? String(rotate) : null);
    setData(this.img, "crop", crop ? cropToken(crop) : null);
    setData(this.img, "rotate", rotate != null ? String(rotate) : null);
    if (this.img.getAttribute("src") !== attrs.src) this.img.src = attrs.src;
    this.img.alt = attrs.alt;
    if (attrs.title) this.img.title = attrs.title;
    else this.img.removeAttribute("title");
    // A percentage width needs a definite float width; a pixel width shrink-wraps to the picture.
    this.dom.style.width = wrap === "square" && typeof attrs.width === "string" && attrs.width.endsWith("%") ? attrs.width : "";
    const natural = this.img.naturalWidth > 0 && this.img.naturalHeight > 0;
    if (crop && natural) {
      const container = this.view.dom.getBoundingClientRect().width || this.img.naturalWidth;
      const box = croppedFrame(cssPx(attrs.width, container, this.img.naturalWidth), this.img.naturalWidth, this.img.naturalHeight, crop);
      this.frame.style.width = `${box.frameWidth}px`;
      this.frame.style.height = `${box.frameHeight}px`;
      this.turn.style.display = "block";
      this.turn.style.width = "100%";
      this.turn.style.height = "100%";
      this.turn.style.transform = rotate != null ? `rotate(${rotate}deg)` : "";
      this.cropBox.style.display = "block";
      this.cropBox.style.width = "100%";
      this.cropBox.style.height = "100%";
      this.cropBox.style.overflow = "hidden";
      this.img.style.width = `${box.imageWidth}px`;
      this.img.style.height = `${box.imageHeight}px`;
      this.img.style.maxWidth = "none";
      this.img.style.marginLeft = `${box.offsetX}px`;
      this.img.style.marginTop = `${box.offsetY}px`;
      this.img.style.transform = "";
      return;
    }
    this.frame.style.width = "";
    this.frame.style.height = "";
    this.turn.style.cssText = "";
    this.cropBox.style.cssText = "";
    this.img.style.width = attrs.width ?? "";
    this.img.style.height = "";
    this.img.style.maxWidth = "";
    this.img.style.marginLeft = "";
    this.img.style.marginTop = "";
    this.img.style.transform = rotate != null ? `rotate(${rotate}deg)` : "";
  }

  private startResize(event: PointerEvent, side: "left" | "right") {
    if (!this.view.editable) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const cropped = Boolean(pictureCrop(this.node.attrs.crop));
    // A crop's window is the frame; the image inside it is the uncropped source and is wider.
    const startWidth = (cropped ? this.frame : this.img).getBoundingClientRect().width;
    const startHeight = this.frame.getBoundingClientRect().height;
    const startImage = { width: this.img.offsetWidth, height: this.img.offsetHeight, left: Number.parseFloat(this.img.style.marginLeft) || 0, top: Number.parseFloat(this.img.style.marginTop) || 0 };
    const maxWidth = this.view.dom.getBoundingClientRect().width || startWidth;
    let width = startWidth;
    this.dom.classList.add("is-resizing");
    const move = (moveEvent: PointerEvent) => {
      width = resizedWidth(startWidth, moveEvent.clientX - startX, maxWidth, side);
      if (!cropped) {
        this.img.style.width = `${width}px`;
        return;
      }
      const scale = width / startWidth;
      this.frame.style.width = `${width}px`;
      this.frame.style.height = `${startHeight * scale}px`;
      this.img.style.width = `${startImage.width * scale}px`;
      this.img.style.height = `${startImage.height * scale}px`;
      this.img.style.marginLeft = `${startImage.left * scale}px`;
      this.img.style.marginTop = `${startImage.top * scale}px`;
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

function setData(el: HTMLElement, name: string, value: string | null) {
  if (value) el.dataset[name] = value;
  else delete el.dataset[name];
}

const PHOTO_TYPES = new Set(["image", "inline_image"]);

/** Clicks on the picture bar keep the picture selected so its fields can be edited. */
function keepsPhoto(target: EventTarget | null) {
  const element =
    target && typeof target === "object" && "closest" in target && typeof (target as Element).closest === "function" ? (target as Element) : null;
  return Boolean(element?.closest("[data-keep-photo]"));
}

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
      handleDOMEvents: {
        // The picture is contenteditable=false. A click on it otherwise lets the
        // browser drop the caret in the text beside it, and that replaces the
        // node selection — so the picture bar closes on the click that should
        // open it. A leading picture starts selected, and that click is a no-op
        // in ProseMirror, which is when the caret move wins.
        mousedown(view, event) {
          if (event.button !== 0 || event.shiftKey) return false;
          const target = event.target;
          if (!eventOnPhoto(target) || (target instanceof Element && target.closest(".image-handle"))) return false;
          event.preventDefault();
          const found = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (!found || found.inside < 0) return true;
          const node = view.state.doc.nodeAt(found.inside);
          if (!node || !PHOTO_TYPES.has(node.type.name)) return true;
          const selected = view.state.selection;
          if (!(selected instanceof NodeSelection) || selected.from !== found.inside) {
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, found.inside)).setMeta("pointer", true));
          }
          return true;
        },
      },
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
        if (keepsPhoto(event.target)) return;
        // The bar can open under the pointer before mouseup. The click's target is then
        // a shared ancestor, so also trust whatever is actually under the cursor.
        const mouse = event as MouseEvent;
        const under = (mouse.clientX || mouse.clientY) && typeof document.elementFromPoint === "function" ? document.elementFromPoint(mouse.clientX, mouse.clientY) : null;
        if (keepsPhoto(under)) return;
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

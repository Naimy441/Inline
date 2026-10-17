import { GapCursor } from "prosemirror-gapcursor";
import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection, Plugin, Selection, TextSelection, type EditorState } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import { croppedFrame, cropToken, cssPx, pictureCrop, pictureRotate, pictureWidth, pictureWrap } from "@/lib/doc/picture";
import {
  HANDLES,
  PictureLineSelection,
  gapBesidePicture,
  localPointerDelta,
  movePicture,
  pictureArrowMotion,
  pictureLineAt,
  resizedBox,
  type HandleName,
  type PictureSelection,
} from "@/lib/editor/pictureEdit";

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
  return resizedBox({ width: startWidth, height: startWidth }, dx, 0, side === "right" ? "e" : "w", maxWidth).width;
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
    // The node is draggable for ProseMirror, which starts a native drag and
    // ends the pointer stream. Moving a picture uses the pointer, so cancel that.
    this.dom.addEventListener("dragstart", (event) => event.preventDefault());
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
    for (const name of HANDLES) {
      const handle = document.createElement("span");
      handle.className = `image-handle image-handle-${name}${name === "e" ? " image-handle-right" : ""}${name === "w" ? " image-handle-left" : ""}`;
      handle.dataset.handle = name;
      handle.setAttribute("aria-hidden", "true");
      handle.addEventListener("pointerdown", (event) => this.startResize(event, name));
      this.frame.append(handle);
    }
    const stem = document.createElement("span");
    stem.className = "image-rotate";
    stem.setAttribute("aria-hidden", "true");
    const dot = document.createElement("span");
    dot.className = "image-rotate-dot";
    dot.addEventListener("pointerdown", (event) => this.startRotate(event));
    stem.append(dot);
    this.frame.append(stem);
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
    const previousClasses = (this.dom.dataset.canvasClass || "").split(/\s+/).filter(Boolean);
    for (const name of previousClasses) this.dom.classList.remove(name);
    if (attrs.canvasClass) {
      for (const name of attrs.canvasClass.split(/\s+/)) this.dom.classList.add(name);
      this.dom.dataset.canvasClass = attrs.canvasClass;
    } else delete this.dom.dataset.canvasClass;
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
    const width = pictureWidth(attrs.width);
    const height = pictureWidth(attrs.height);
    const heightPx = height && !height.endsWith("%") ? height : "";
    const percent = Boolean(width?.endsWith("%"));
    // The figure stays inside the text column. A percent is that share of the column;
    // a pixel width larger than the column shrinks to it (max-width on the frame and image).
    this.dom.style.maxWidth = "100%";
    this.frame.style.maxWidth = "100%";
    this.dom.style.width = wrap === "square" && percent && width ? width : "";
    const natural = this.img.naturalWidth > 0 && this.img.naturalHeight > 0;
    if (crop && natural) {
      const container = this.view.dom.getBoundingClientRect().width || this.img.naturalWidth;
      const box = croppedFrame(cssPx(width, container, this.img.naturalWidth), this.img.naturalWidth, this.img.naturalHeight, crop);
      this.frame.style.width = `${box.frameWidth}px`;
      this.frame.style.height = `${box.frameHeight}px`;
      this.turn.style.display = "block";
      this.turn.style.width = "100%";
      this.turn.style.height = "100%";
      this.turn.style.transform = "";
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
      if (heightPx) {
        const frameH = Number.parseFloat(heightPx);
        const scaleY = frameH / box.frameHeight;
        this.frame.style.height = `${frameH}px`;
        this.img.style.height = `${box.imageHeight * scaleY}px`;
        this.img.style.marginTop = `${box.offsetY * scaleY}px`;
      }
      this.frame.style.transform = rotate != null ? `rotate(${rotate}deg)` : "";
      return;
    }
    this.frame.style.width = percent && width ? (wrap === "square" ? "100%" : width) : "";
    this.frame.style.height = "";
    this.turn.style.cssText = "";
    this.cropBox.style.cssText = "";
    this.img.style.width = percent ? "100%" : (width ?? "");
    this.img.style.height = heightPx || "auto";
    this.img.style.maxWidth = "100%";
    this.img.style.marginLeft = "";
    this.img.style.marginTop = "";
    this.img.style.transform = "";
    this.frame.style.height = heightPx;
    this.frame.style.transform = rotate != null ? `rotate(${rotate}deg)` : "";
  }

  private startResize(event: PointerEvent, name: HandleName) {
    if (!this.view.editable) return;
    event.preventDefault();
    event.stopPropagation();
    const knob = event.currentTarget as HTMLElement;
    knob.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const cropped = Boolean(pictureCrop(this.node.attrs.crop));
    // offsetWidth is the layout size. A rotated frame's bounding box is larger than the picture.
    const startWidth = (cropped ? this.frame : this.img).offsetWidth || this.frame.offsetWidth;
    const startHeight = this.frame.offsetHeight || this.img.offsetHeight;
    const startImage = { width: this.img.offsetWidth, height: this.img.offsetHeight, left: Number.parseFloat(this.img.style.marginLeft) || 0, top: Number.parseFloat(this.img.style.marginTop) || 0 };
    const maxWidth = this.view.dom.getBoundingClientRect().width || startWidth;
    const degrees = pictureRotate(this.node.attrs.rotate) ?? 0;
    let box = { width: startWidth, height: startHeight };
    this.dom.classList.add("is-resizing");
    const move = (moveEvent: PointerEvent) => {
      const delta = localPointerDelta(moveEvent.clientX - startX, moveEvent.clientY - startY, degrees);
      box = resizedBox({ width: startWidth, height: startHeight }, delta.dx, delta.dy, name, maxWidth);
      this.paintSize(box, startWidth, startHeight, startImage, cropped);
    };
    const end = () => {
      knob.removeEventListener("pointermove", move);
      knob.removeEventListener("pointerup", end);
      knob.removeEventListener("pointercancel", end);
      this.dom.classList.remove("is-resizing");
      const pos = this.getPos();
      if (pos === undefined || (Math.abs(box.width - startWidth) < 2 && Math.abs(box.height - startHeight) < 2)) {
        this.render();
        return;
      }
      const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, width: `${box.width}px`, height: `${box.height}px` });
      tr.setSelection(NodeSelection.create(tr.doc, pos));
      this.view.dispatch(tr);
    };
    knob.addEventListener("pointermove", move);
    knob.addEventListener("pointerup", end);
    knob.addEventListener("pointercancel", end);
  }

  private paintSize(
    box: { width: number; height: number },
    startWidth: number,
    startHeight: number,
    startImage: { width: number; height: number; left: number; top: number },
    cropped: boolean,
  ) {
    if (!cropped) {
      this.img.style.width = `${box.width}px`;
      this.img.style.height = `${box.height}px`;
      this.frame.style.height = `${box.height}px`;
      return;
    }
    const scaleX = box.width / startWidth;
    const scaleY = box.height / startHeight;
    this.frame.style.width = `${box.width}px`;
    this.frame.style.height = `${box.height}px`;
    this.img.style.width = `${startImage.width * scaleX}px`;
    this.img.style.height = `${startImage.height * scaleY}px`;
    this.img.style.marginLeft = `${startImage.left * scaleX}px`;
    this.img.style.marginTop = `${startImage.top * scaleY}px`;
  }

  private startRotate(event: PointerEvent) {
    if (!this.view.editable) return;
    event.preventDefault();
    event.stopPropagation();
    const dot = event.currentTarget as HTMLElement;
    dot.setPointerCapture(event.pointerId);
    const rect = this.frame.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let degrees = pictureRotate(this.node.attrs.rotate) ?? 0;
    this.dom.classList.add("is-resizing");
    const move = (moveEvent: PointerEvent) => {
      const angle = (Math.atan2(moveEvent.clientX - cx, cy - moveEvent.clientY) * 180) / Math.PI;
      const snapped = [0, 90, 180, -180, -90, 270].find((mark) => Math.abs(angle - mark) < 4);
      degrees = snapped != null ? ((snapped % 360) + 360) % 360 : angle;
      if (degrees > 180) degrees -= 360;
      this.frame.style.transform = Math.abs(degrees) < 0.01 ? "" : `rotate(${degrees}deg)`;
    };
    const end = () => {
      dot.removeEventListener("pointermove", move);
      dot.removeEventListener("pointerup", end);
      dot.removeEventListener("pointercancel", end);
      this.dom.classList.remove("is-resizing");
      const pos = this.getPos();
      if (pos === undefined) return;
      const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, rotate: pictureRotate(degrees) });
      tr.setSelection(NodeSelection.create(tr.doc, pos));
      this.view.dispatch(tr);
    };
    dot.addEventListener("pointermove", move);
    dot.addEventListener("pointerup", end);
    dot.addEventListener("pointercancel", end);
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
    const target = event.target as HTMLElement | null;
    return Boolean(target?.closest?.(".image-handle, .image-rotate, .image-rotate-dot"));
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
  return Boolean(element?.closest("img, .image-handle, .image-rotate, .image-rotate-dot"));
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

function preferredSide(view: EditorView, imagePos: number, event: MouseEvent, fallback: "before" | "after"): "before" | "after" {
  const dom = view.nodeDOM(imagePos);
  const rect = dom instanceof HTMLElement ? dom.getBoundingClientRect() : null;
  if (!rect || rect.height < 1 || typeof event.clientY !== "number") return fallback;
  if (event.clientY > rect.bottom - 1) return "after";
  if (event.clientY < rect.top + 1) return "before";
  return event.clientY >= rect.top + rect.height / 2 ? "after" : "before";
}

/**
 * A click in the gap beside a picture. The line under a picture is a paragraph
 * when one is there; otherwise it becomes one, so the caret is a text caret
 * and typing works. A gap cursor is a horizontal bar and cannot hold text.
 */
function placeCaretByPhoto(view: EditorView, boundary: number, side: "before" | "after"): boolean {
  if (!view.editable || view.isDestroyed) return false;
  const $pos = view.state.doc.resolve(boundary);
  const photo = side === "after" ? $pos.nodeBefore : $pos.nodeAfter;
  if (!photo || !PHOTO_TYPES.has(photo.type.name)) return false;
  const toward = side === "after" ? $pos.nodeAfter : $pos.nodeBefore;
  if (toward?.isTextblock) {
    const caret = side === "after" ? boundary + 1 : boundary - 1;
    const text = TextSelection.create(view.state.doc, caret);
    if (text.eq(view.state.selection)) return true;
    view.dispatch(view.state.tr.setSelection(text).scrollIntoView().setMeta("pointer", true));
    return true;
  }
  if (toward) {
    const found = Selection.findFrom($pos, side === "after" ? 1 : -1, true);
    if (found instanceof TextSelection) {
      if (!found.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(found).scrollIntoView().setMeta("pointer", true));
      return true;
    }
  }
  const paragraph = view.state.schema.nodes.paragraph!.create();
  const tr = view.state.tr.insert(boundary, paragraph);
  tr.setSelection(TextSelection.create(tr.doc, boundary + 1)).scrollIntoView().setMeta("pointer", true);
  view.dispatch(tr);
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
          if (target instanceof Element && target.closest(".image-handle, .image-rotate, .image-rotate-dot")) return false;
          if (!eventOnPhoto(target)) return false;
          event.preventDefault();
          const found = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (!found || found.inside < 0) return true;
          const node = view.state.doc.nodeAt(found.inside);
          if (!node || !PHOTO_TYPES.has(node.type.name)) return true;
          const selected = view.state.selection;
          if (!(selected instanceof NodeSelection) || selected.from !== found.inside) {
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, found.inside)).setMeta("pointer", true));
          }
          // preventDefault keeps the browser from moving focus, so Backspace would miss the picture.
          view.focus();
          if (view.editable) trackPictureDrag(view, event, found.inside);
          return true;
        },
      },
      handleKeyDown(view, event) {
        return arrowAroundPicture(view, event);
      },
      createSelectionBetween(view, $anchor, $head) {
        if ($anchor.pos !== $head.pos || $anchor.parent.isTextblock) return null;
        const before = $anchor.nodeBefore;
        const after = $anchor.nodeAfter;
        if (after && PHOTO_TYPES.has(after.type.name) && before?.isTextblock) return TextSelection.create(view.state.doc, $anchor.pos - 1);
        if (before && PHOTO_TYPES.has(before.type.name) && after?.isTextblock) return TextSelection.create(view.state.doc, $anchor.pos + 1);
        return null;
      },
      handleClick(view, pos, event) {
        if (event.button !== 0 || event.shiftKey || eventOnPhoto(event.target)) return false;
        const $pos = view.state.doc.resolve(pos);
        if ($pos.parent.isTextblock) return false;
        const before = $pos.nodeBefore;
        const after = $pos.nodeAfter;
        const photoBefore = Boolean(before && PHOTO_TYPES.has(before.type.name));
        const photoAfter = Boolean(after && PHOTO_TYPES.has(after.type.name));
        if (!photoBefore && !photoAfter) return false;
        const imagePos = photoBefore ? pos - before!.nodeSize : pos;
        const beside = before?.type.name === "image" || after?.type.name === "image" ? sideOfPicture(view, imagePos, event) : null;
        // The empty block around a picture is not the picture. Only the right side
        // of that block is the picture's line; the left side leaves the selection.
        if (beside === "right" && applyPictureSide(view, imagePos, beside)) return true;
        const side = preferredSide(view, imagePos, event, photoBefore ? "after" : "before");
        const boundary = side === "after" ? imagePos + (view.state.doc.nodeAt(imagePos)?.nodeSize ?? 1) : imagePos;
        return placeCaretByPhoto(view, boundary, side);
      },
      handleTextInput(view, from, to, text) {
        if (!(view.state.selection instanceof GapCursor || view.state.selection instanceof PictureLineSelection) || from !== to) return false;
        const $pos = view.state.doc.resolve(from);
        const beside = ($pos.nodeBefore && PHOTO_TYPES.has($pos.nodeBefore.type.name)) || ($pos.nodeAfter && PHOTO_TYPES.has($pos.nodeAfter.type.name));
        if (!beside) return false;
        const paragraph = view.state.schema.nodes.paragraph!.create();
        const tr = view.state.tr.insert(from, paragraph);
        tr.insertText(text, from + 1);
        tr.setSelection(TextSelection.create(tr.doc, from + 1 + text.length)).scrollIntoView();
        view.dispatch(tr);
        return true;
      },
      handleClickOn(view, _pos, node, nodePos, event) {
        // Right-click keeps the editor's own menu; shift-click still extends a text selection.
        if (event.button !== 0 || event.shiftKey) return false;
        if (!PHOTO_TYPES.has(node.type.name) || eventOnPhoto(event.target)) return false;
        if (node.type.name === "image") {
          const beside = sideOfPicture(view, nodePos, event);
          if (beside === "right" && applyPictureSide(view, nodePos, beside)) return true;
        }
        const side = preferredSide(view, nodePos, event, "after");
        const boundary = side === "after" ? nodePos + node.nodeSize : nodePos;
        return placeCaretByPhoto(view, boundary, side);
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
        if (pictureInMargin(editorView, mouse)) return;
        const target = event.target;
        if (target && typeof (target as Node).nodeType === "number" && editorView.dom.contains(target as Node)) return;
        if (!moveCursorOffPhoto(editorView, editorView.state.selection.from)) return;
        forgetRecentClick(editorView);
      };
      const onMargin = (event: Event) => {
        if (!("button" in event) || (event as MouseEvent).button !== 0 || !editorView.editable || editorView.isDestroyed) return;
        const mouse = event as MouseEvent;
        if (mouse.target && editorView.dom.contains(mouse.target as Node)) return;
        const hit = pictureInMargin(editorView, mouse);
        if (!hit) return;
        mouse.preventDefault();
        mouse.stopPropagation();
        if (hit.side === "left") {
          editorView.dispatch(editorView.state.tr.setSelection(NodeSelection.create(editorView.state.doc, hit.pos)).scrollIntoView().setMeta("pointer", true));
        } else {
          const node = editorView.state.doc.nodeAt(hit.pos);
          const gap = node ? pictureLineAt(editorView.state.doc, hit.pos + node.nodeSize) : null;
          if (gap) editorView.dispatch(editorView.state.tr.setSelection(gap).scrollIntoView().setMeta("pointer", true));
        }
        editorView.focus();
      };
      const line = document.createElement("div");
      line.className = "picture-line-caret";
      line.setAttribute("aria-hidden", "true");
      line.hidden = true;
      document.body.append(line);
      const placeLine = () => {
        if (editorView.isDestroyed) return;
        const sel = editorView.state.selection;
        const gap = sel instanceof PictureLineSelection || sel instanceof GapCursor ? gapBesidePicture(editorView.state.doc, sel.from) : null;
        const dom = gap ? editorView.nodeDOM(gap.imagePos) : null;
        const frame = dom instanceof HTMLElement ? (dom.querySelector(".image-frame") ?? dom) : null;
        if (!gap || !editorView.hasFocus() || !(frame instanceof HTMLElement)) {
          line.hidden = true;
          editorView.dom.classList.remove("picture-line");
          return;
        }
        const rect = frame.getBoundingClientRect();
        if (rect.height < 2) {
          line.hidden = true;
          return;
        }
        const height = 20;
        line.hidden = false;
        line.style.height = `${height}px`;
        line.style.top = `${rect.bottom - height}px`;
        line.style.left = `${gap.side === "before" ? rect.left : rect.right - 2}px`;
        editorView.dom.classList.add("picture-line");
      };
      const onScroll = () => placeLine();
      editorView.root.addEventListener("mousedown", onMargin, true);
      editorView.root.addEventListener("click", onClick);
      editorView.dom.ownerDocument.addEventListener("scroll", onScroll, true);
      return {
        update: placeLine,
        destroy: () => {
          line.remove();
          editorView.root.removeEventListener("mousedown", onMargin, true);
          editorView.root.removeEventListener("click", onClick);
          editorView.dom.ownerDocument.removeEventListener("scroll", onScroll, true);
        },
      };
    },
  });
}

function sideOfPicture(view: EditorView, imagePos: number, event: MouseEvent): "left" | "right" | null {
  if (typeof event.clientX !== "number" || typeof event.clientY !== "number") return null;
  const dom = view.nodeDOM(imagePos);
  if (!(dom instanceof HTMLElement)) return null;
  const frame = dom.querySelector(".image-frame") ?? dom;
  const rect = frame.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  if (event.clientY < rect.top - 4 || event.clientY > rect.bottom + 4) return null;
  if (event.clientX < rect.left - 1) return "left";
  if (event.clientX > rect.right + 1) return "right";
  return null;
}

function applyPictureSide(view: EditorView, imagePos: number, side: "left" | "right") {
  if (side === "left") {
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, imagePos)).scrollIntoView().setMeta("pointer", true));
    return true;
  }
  const node = view.state.doc.nodeAt(imagePos);
  const gap = node ? pictureLineAt(view.state.doc, imagePos + node.nodeSize) : null;
  if (!gap) return false;
  view.dispatch(view.state.tr.setSelection(gap).scrollIntoView().setMeta("pointer", true));
  return true;
}

function pictureInMargin(view: EditorView, event: MouseEvent): { pos: number; side: "left" | "right" } | null {
  const target = event.target;
  if (target instanceof Element && target.closest("[data-keep-photo], .picture-bar, .picture-menu, .picture-options, img, .image-handle, .image-rotate, p, h1, h2, h3, h4, h5, h6, li, td, th, pre, blockquote")) return null;
  let found: { pos: number; side: "left" | "right" } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (found || node.type.name !== "image") return;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;
    const frame = dom.querySelector(".image-frame") ?? dom;
    const rect = frame.getBoundingClientRect();
    if (rect.height < 2) return;
    if (event.clientY < rect.top - 3 || event.clientY > rect.bottom + 3) return;
    const page = dom.closest(".page-stack") ?? view.dom;
    const pageRect = page.getBoundingClientRect();
    if (event.clientX < pageRect.left - 12 || event.clientX > pageRect.right + 12) return;
    if (event.clientX < rect.left - 2) found = { pos, side: "left" };
    else if (event.clientX > rect.right + 2) found = { pos, side: "right" };
  });
  return found;
}

function describeSelection(state: EditorState): PictureSelection | null {
  const selection = state.selection;
  if (selection instanceof PictureLineSelection || selection instanceof GapCursor) return { type: "gap", pos: selection.from };
  if (selection instanceof NodeSelection) return { type: "node", pos: selection.from, name: selection.node.type.name };
  if (selection instanceof TextSelection) return { type: "text", head: selection.head, empty: selection.empty };
  return null;
}

function besidePictureEdge(view: EditorView, dir: "up" | "down"): boolean {
  const selection = view.state.selection;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const $head = selection.$head;
  if (!$head.parent.isTextblock) return false;
  const toward = dir === "down" ? $head.after() : $head.before();
  const node = dir === "down" ? view.state.doc.nodeAt(toward) : view.state.doc.resolve(toward).nodeBefore;
  if (node?.type.name !== "image") return false;
  // The last line above the picture, or the first line below it, even when paragraph
  // spacing leaves a gap taller than one line. A line still inside the paragraph is not an edge.
  if (view.endOfTextblock(dir)) return true;
  const imagePos = dir === "down" ? toward : toward - node.nodeSize;
  let coords: { top: number; bottom: number };
  try {
    coords = view.coordsAtPos(selection.head);
  } catch {
    return view.endOfTextblock(dir);
  }
  const dom = view.nodeDOM(imagePos);
  const frame = dom instanceof HTMLElement ? (dom.querySelector(".image-frame") ?? dom) : null;
  if (!(frame instanceof HTMLElement)) return view.endOfTextblock(dir);
  const rect = frame.getBoundingClientRect();
  if (rect.height < 2 || coords.bottom <= coords.top) return view.endOfTextblock(dir);
  const line = Math.max(14, coords.bottom - coords.top);
  if (dir === "down") return coords.top < rect.top && coords.bottom + line * 0.65 >= rect.top;
  return coords.bottom > rect.bottom && coords.top - line * 0.65 <= rect.bottom;
}

function arrowAroundPicture(view: EditorView, event: KeyboardEvent) {
  const dir = event.key === "ArrowDown" ? "down" : event.key === "ArrowUp" ? "up" : event.key === "ArrowLeft" ? "left" : event.key === "ArrowRight" ? "right" : null;
  if (!dir || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
  const described = describeSelection(view.state);
  if (!described) return false;
  const atEdge = described.type === "text" && (dir === "up" || dir === "down") ? besidePictureEdge(view, dir) : described.type !== "text";
  const motion = pictureArrowMotion(view.state.doc, described, dir, atEdge);
  if (!motion) return false;
  if (motion.kind === "gap") {
    const gap = pictureLineAt(view.state.doc, motion.pos);
    if (!gap) return false;
    view.dispatch(view.state.tr.setSelection(gap).scrollIntoView());
    return true;
  }
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, motion.pos)).scrollIntoView());
  return true;
}

function dropCaret() {
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

/** Drag the picture. A bold blue caret marks the landing spot; the drop moves it there. */
function trackPictureDrag(view: EditorView, event: MouseEvent, from: number) {
  const startX = event.clientX;
  const startY = event.clientY;
  let dragging = false;
  let dropAt: number | null = null;
  const caret = dropCaret();
  const move = (ev: PointerEvent) => {
    if (view.isDestroyed) {
      finish();
      return;
    }
    if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
    if (!dragging) {
      dragging = true;
      const dom = view.nodeDOM(from);
      if (dom instanceof HTMLElement) dom.classList.add("is-dragging");
    }
    const found = view.posAtCoords({ left: ev.clientX, top: ev.clientY });
    if (!found) {
      caret.hidden = true;
      dropAt = null;
      return;
    }
    dropAt = found.pos;
    try {
      const coords = view.coordsAtPos(found.pos);
      const height = Math.max(18, coords.bottom - coords.top);
      caret.hidden = false;
      caret.style.height = `${height}px`;
      caret.style.top = `${coords.top}px`;
      caret.style.left = `${coords.left - 1}px`;
    } catch {
      caret.hidden = true;
    }
  };
  const finish = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", up, true);
    caret.hidden = true;
    if (view.isDestroyed) return;
    view.dom.querySelectorAll(".is-dragging").forEach((el) => el.classList.remove("is-dragging"));
    if (!dragging || dropAt == null) return;
    const tr = movePicture(view.state, from, dropAt);
    if (tr) view.dispatch(tr.scrollIntoView());
  };
  const up = () => finish();
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", up, true);
}

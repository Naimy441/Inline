import { DOMSerializer, type Node as PMNode } from "prosemirror-model";
import { NodeSelection, Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { schema } from "@/lib/doc/schema";
import { dataUrlToBlob } from "@/lib/editor/imageView";

/**
 * Copying a selected picture puts the picture itself on the clipboard, so it
 * pastes into other apps: a PNG, and HTML whose <img> carries the picture as
 * a data: URL (Inline's own /api/uploads address means nothing elsewhere).
 * The HTML also keeps the address it came from (data-inline-src), so pasting
 * it back into Inline uses the stored file rather than uploading a copy.
 */

const UPLOADS = "/api/uploads/";

function isPicture(node: PMNode) {
  return node.type === schema.nodes.image || node.type === schema.nodes.inline_image;
}

/** The picture as a PNG data: URL, drawn from the loaded image; null when it isn't loaded or comes from another site. */
export function pngDataUrl(img: HTMLImageElement): string | null {
  if (!img.complete || !img.naturalWidth) return null;
  try {
    const canvas = img.ownerDocument.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")?.drawImage(img, 0, 0);
    const url = canvas.toDataURL("image/png");
    return url.startsWith("data:image/png") ? url : null;
  } catch {
    // A picture from another site taints the canvas.
    return null;
  }
}

/** The picture's node as clipboard HTML: Inline's own markup, its image shown from `data` when there is one, and its address made absolute. */
export function pictureHtml(node: PMNode, document: Document, origin: string, data: string | null) {
  const dom = DOMSerializer.fromSchema(schema).serializeNode(node, { document }) as HTMLElement;
  const img = dom.tagName === "IMG" ? dom : dom.querySelector("img");
  const src = img?.getAttribute("src");
  if (img && src) {
    const absolute = new URL(src, origin).href;
    img.setAttribute("data-inline-src", absolute);
    img.setAttribute("src", data ?? absolute);
    img.removeAttribute("draggable");
  }
  const wrap = document.createElement("div");
  wrap.append(dom);
  return wrap.innerHTML;
}

/** Pictures copied from this Inline go back to the file they were shown from (lib/editor/paste.ts runs this on pasted HTML). */
export function restoreCopiedPictures(root: ParentNode, origin: string) {
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img[data-inline-src]"))) {
    const source = img.getAttribute("data-inline-src") ?? "";
    if (source.startsWith(`${origin}${UPLOADS}`)) img.setAttribute("src", source.slice(origin.length));
    img.removeAttribute("data-inline-src");
  }
}

function copyPicture(view: EditorView, event: ClipboardEvent, cut: boolean) {
  const selection = view.state.selection;
  if (!(selection instanceof NodeSelection) || !isPicture(selection.node) || !event.clipboardData) return false;
  const dom = view.nodeDOM(selection.from) as HTMLElement | null;
  const img = dom?.tagName === "IMG" ? (dom as HTMLImageElement) : dom?.querySelector("img");
  const data = img ? pngDataUrl(img) : null;
  const html = pictureHtml(selection.node, document, location.origin, data);
  event.preventDefault();
  event.clipboardData.clearData();
  event.clipboardData.setData("text/html", html);
  // The picture itself, for apps that take a picture rather than HTML. Only the async clipboard can hold one.
  const png = data ? dataUrlToBlob(data) : null;
  if (png && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    void navigator.clipboard.write([new ClipboardItem({ "image/png": png, "text/html": new Blob([html], { type: "text/html" }) })]).catch(() => undefined);
  }
  if (cut) view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"));
  return true;
}

export function imageClipboardPlugin() {
  return new Plugin({
    props: {
      handleDOMEvents: {
        copy: (view, event) => copyPicture(view, event, false),
        cut: (view, event) => view.editable && copyPicture(view, event, true),
      },
    },
  });
}

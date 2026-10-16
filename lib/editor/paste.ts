import { Slice } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";
import { cssSizeToPt, schema } from "@/lib/doc/schema";
import { restoreCopiedPictures } from "@/lib/editor/imageClipboard";

/**
 * Google Docs writes a paragraph's line spacing on the clipboard as the
 * spacing times 1.2: 1.15 arrives as "line-height:1.38", single as 1.2.
 */
const GOOGLE_LINE_FACTOR = 1.2;

const BLOCK = /^(P|H[1-6]|UL|OL|TABLE|DIV|BLOCKQUOTE|HR|BR)$/;
const TEXTBLOCK = "p, h1, h2, h3, h4, h5, h6";

/** HTML Google Docs put on the clipboard: everything is wrapped in an element with a docs-internal-guid id. */
export function isGoogleDocsHtml(root: ParentNode) {
  return Boolean(root.querySelector('[id^="docs-internal-guid-"]'));
}

/** Whether a <br> stands between blocks, where Google writes an empty paragraph, rather than breaking a line of text. */
function separatesBlocks(br: Element) {
  if (br.closest(TEXTBLOCK)) return false;
  const before = br.previousElementSibling;
  const after = br.nextElementSibling;
  return (!before || BLOCK.test(before.tagName)) && (!after || BLOCK.test(after.tagName));
}

/** The textblock nearest a blank line, whose spacing and text size the blank line shares (Google gives them the same). */
function neighbour(br: Element) {
  for (let el = br.previousElementSibling; el; el = el.previousElementSibling) if (el.matches(TEXTBLOCK)) return el as HTMLElement;
  for (let el = br.nextElementSibling; el; el = el.nextElementSibling) if (el.matches(TEXTBLOCK)) return el as HTMLElement;
  return null;
}

/**
 * Read Google Docs' clipboard HTML as Google shows it: line spacing as
 * Google's own figure, and each empty paragraph (a <br> between paragraphs)
 * as one empty paragraph, as tall as a line of its neighbours' text. Changes
 * `root` in place; returns whether it was Google's.
 */
export function fixGoogleDocsHtml(root: HTMLElement) {
  if (!isGoogleDocsHtml(root)) return false;
  for (const br of Array.from(root.querySelectorAll("br.Apple-interchange-newline"))) br.remove();
  for (const block of Array.from(root.querySelectorAll<HTMLElement>(TEXTBLOCK))) {
    const lineHeight = block.style.lineHeight;
    if (/^[\d.]+$/.test(lineHeight)) block.style.lineHeight = String(Math.round((Number(lineHeight) / GOOGLE_LINE_FACTOR) * 100) / 100);
  }
  const document = root.ownerDocument;
  for (const br of Array.from(root.querySelectorAll("br"))) {
    if (!separatesBlocks(br)) continue;
    const blank = document.createElement("p");
    const near = neighbour(br);
    if (near) {
      for (const property of ["line-height", "margin-top", "margin-bottom"]) {
        const value = near.style.getPropertyValue(property);
        if (value) blank.style.setProperty(property, value);
      }
      const spans = near.querySelectorAll<HTMLElement>("span[style]");
      const size = cssSizeToPt(spans[spans.length - 1]?.style.fontSize);
      if (size) blank.setAttribute("data-font-size", String(size));
    }
    br.replaceWith(blank);
  }
  return true;
}

/** Whether Google's clipboard HTML starts with a whole paragraph (a part of one is a bare <span>). */
export function startsWithParagraph(root: HTMLElement) {
  const wrapper = root.querySelector('[id^="docs-internal-guid-"]');
  return Boolean(wrapper?.firstElementChild?.matches(`${TEXTBLOCK}, br`));
}

/**
 * Pasted HTML as Inline reads it (ProseMirror's transformPastedHTML):
 * Google Docs' fixed by `fixGoogleDocsHtml`, and pictures copied from this
 * Inline shown from their stored files again. Other HTML comes back as it
 * was. `paragraphs` says the paste starts with a whole Google paragraph,
 * formatting and all.
 */
export function transformPastedHtml(html: string, origin = typeof location === "undefined" ? "" : location.origin): { html: string; paragraphs: boolean } {
  const google = html.includes("docs-internal-guid-");
  const copied = html.includes("data-inline-src");
  if (!(google || copied) || typeof DOMParser === "undefined") return { html, paragraphs: false };
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const paragraphs = google && startsWithParagraph(parsed.body);
  if (copied) restoreCopiedPictures(parsed.body, origin);
  if (google) fixGoogleDocsHtml(parsed.body);
  return { html: parsed.body.innerHTML, paragraphs };
}

/**
 * Pasted whole paragraphs going into an empty one replace it, as in Google
 * Docs, so the first keeps its own spacing rather than taking the empty
 * paragraph's. ProseMirror otherwise joins the first pasted paragraph to the
 * one the cursor is in.
 */
export function pasteIntoEmptyTextblock(slice: Slice, state: EditorState) {
  const { selection } = state;
  const parent = selection.$from.parent;
  if (!selection.empty || !parent.isTextblock || parent.content.size || slice.openStart !== 1 || !slice.content.firstChild?.isTextblock) return slice;
  return new Slice(slice.content, 0, slice.openEnd);
}

/**
 * A paste that ends with a picture (or a rule or page break) gets a line
 * after it for the cursor, as in Google Docs, so the cursor is a text caret
 * after the picture: not the picture selected, which typing would replace,
 * nor the gap cursor after it. The line is the paragraph the paste went into,
 * which ProseMirror otherwise replaces when it's empty. Null when the paste
 * ends otherwise.
 */
export function endWithTextblock(slice: Slice, state: EditorState): Slice | null {
  const last = slice.content.lastChild;
  if (slice.openEnd !== 0 || !last?.isBlock || !last.isAtom) return null;
  const parent = state.selection.$from.parent;
  const paragraph = schema.nodes.paragraph!.create(parent.type === schema.nodes.paragraph ? { ...parent.attrs, id: null, lineBreaks: null } : null);
  return new Slice(slice.content.addToEnd(paragraph), slice.openStart, 1);
}

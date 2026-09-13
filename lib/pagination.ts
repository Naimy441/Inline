/** Letter page geometry. CSS `in` is 96px, matching these constants. */
export const DPI = 96;
export const PAGE_WIDTH = 8.5 * DPI;
export const PAGE_HEIGHT = 11 * DPI;
export const PAGE_MARGIN = 1 * DPI;
export const PAGE_GAP = 24;
export const PAGE_CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
export const PAGE_CONTENT_HEIGHT = PAGE_HEIGHT - PAGE_MARGIN * 2;
export const PAGE_BREAK_HEIGHT = PAGE_MARGIN * 2 + PAGE_GAP;

const BREAK_ATTR = "data-page-break";
const PUSH_ATTR = "data-page-push";
export const MANUAL_BREAK_ATTR = "data-manual-break";

export function createManualPageBreak(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "manual-page-break";
  el.contentEditable = "false";
  el.setAttribute(MANUAL_BREAK_ATTR, "true");
  el.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "manual-page-break-label";
  label.textContent = "Page break";
  el.appendChild(label);
  return el;
}

export function createPageBreak(): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "page-break";
  span.contentEditable = "false";
  span.setAttribute(BREAK_ATTR, "true");
  span.setAttribute("aria-hidden", "true");
  return span;
}

function createPagePush(height: number): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "page-push";
  el.contentEditable = "false";
  el.setAttribute(PUSH_ATTR, "true");
  el.setAttribute("aria-hidden", "true");
  el.style.height = `${Math.max(0, height)}px`;
  return el;
}

function isBreak(node: Node | null): boolean {
  return node instanceof HTMLElement && node.getAttribute(BREAK_ATTR) === "true";
}

function isCaretMark(node: Node | null): boolean {
  return node instanceof HTMLElement && node.getAttribute("data-caret-mark") === "true";
}

function isAtomicBlock(node: Node | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  return node.classList.contains("doc-image") || node.tagName === "IMG" || node.tagName === "TABLE";
}

function isSuggestionDel(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return Boolean(el?.closest(".suggestion-del"));
}

function rejectBreaks(node: Node, proposed = false): number {
  if (proposed && isSuggestionDel(node)) return NodeFilter.FILTER_REJECT;
  if (node instanceof HTMLElement && node.getAttribute(BREAK_ATTR) === "true") {
    return NodeFilter.FILTER_REJECT;
  }
  if (node instanceof HTMLElement && node.getAttribute(PUSH_ATTR) === "true") {
    return NodeFilter.FILTER_REJECT;
  }
  if (isCaretMark(node)) {
    return NodeFilter.FILTER_REJECT;
  }
  if (node instanceof HTMLElement && node.getAttribute(MANUAL_BREAK_ATTR) === "true") {
    return NodeFilter.FILTER_ACCEPT;
  }
  if (node.parentElement?.closest(`[${MANUAL_BREAK_ATTR}]`)) {
    return NodeFilter.FILTER_REJECT;
  }
  if (isAtomicBlock(node)) {
    return NodeFilter.FILTER_ACCEPT;
  }
  if (node.parentElement?.closest(".doc-image, table")) {
    return NodeFilter.FILTER_REJECT;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
  }
  if (node instanceof HTMLElement && node.tagName === "BR") {
    return NodeFilter.FILTER_ACCEPT;
  }
  return NodeFilter.FILTER_SKIP;
}

function lineWalker(root: HTMLElement): TreeWalker {
  return document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: rejectBreaks,
  });
}

export function visualScale(root: HTMLElement): number {
  const visual = root.getBoundingClientRect().width;
  const layout = root.offsetWidth || PAGE_CONTENT_WIDTH;
  return visual / layout || 1;
}

function localY(root: HTMLElement, clientY: number, scale: number): number {
  return (clientY - root.getBoundingClientRect().top) / scale;
}

export function stripPageBreaks(root: HTMLElement) {
  root.querySelectorAll(`[${BREAK_ATTR}], [${PUSH_ATTR}]`).forEach((el) => el.remove());
}

function blockOf(node: Node): Element | null {
  const el = node instanceof Element ? node : node.parentElement;
  return el?.closest("div, p, h1, h2, h3, li, td, pre, blockquote") ?? el;
}

export function getPlainText(root: HTMLElement, proposed = false): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (proposed && isSuggestionDel(node)) return NodeFilter.FILTER_REJECT;
      if (node instanceof HTMLElement) {
        if (node.getAttribute(MANUAL_BREAK_ATTR) === "true") return NodeFilter.FILTER_REJECT;
        if (node.tagName === "BR") {
          if (node.parentElement?.closest(`[${BREAK_ATTR}], [${PUSH_ATTR}], [${MANUAL_BREAK_ATTR}], .doc-image`)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
      return rejectBreaks(node, proposed);
    },
  });
  let text = "";
  let prevBlock: Element | null = null;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node instanceof HTMLElement && node.tagName === "BR") {
      text += "\n";
      continue;
    }
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const block = blockOf(node);
    if (text && !text.endsWith("\n") && block !== prevBlock) {
      text += "\n";
    }
    text += node.textContent ?? "";
    prevBlock = block;
  }
  return text;
}

export function getRawText(root: HTMLElement, proposed = false): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => rejectBreaks(node, proposed),
  });
  let text = "";
  let node: Node | null;
  while ((node = walker.nextNode())) {
    text += (node as Text).data;
  }
  return text;
}

export function rangeFromTextOffsets(root: HTMLElement, start: number, end: number, proposed = false): Range | null {
  const from = pointFromOffset(root, Math.min(start, end), proposed);
  const to = pointFromOffset(root, Math.max(start, end), proposed);
  if (!from || !to) return null;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

export function countWords(text: string): number {
  const parts = text.trim().split(/\s+/);
  return parts[0] === "" ? 0 : parts.length;
}

export type TextRange = { start: number; end: number };

function textOffsetAt(root: HTMLElement, container: Node, offset: number): number | null {
  if (container !== root && !root.contains(container)) return null;
  const marker = document.createRange();
  try {
    marker.setStart(root, 0);
    marker.setEnd(container, offset);
  } catch {
    return null;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: rejectBreaks,
  });
  let acc = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    if (marker.comparePoint(text, 0) > 0) return acc;
    if (marker.comparePoint(text, text.data.length) > 0) {
      return acc + (marker.endContainer === text ? marker.endOffset : 0);
    }
    acc += text.data.length;
  }
  return acc;
}

function pointFromOffset(root: HTMLElement, offset: number, proposed = false): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => rejectBreaks(node, proposed),
  });
  let remaining = offset;
  let node: Node | null;
  let lastText: Text | null = null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    lastText = text;
    const length = text.data.length;
    if (remaining <= length) {
      return { node: text, offset: Math.max(0, remaining) };
    }
    remaining -= length;
  }
  if (!lastText) return null;
  return { node: lastText, offset: lastText.data.length };
}

export function saveCaretOffset(root: HTMLElement): number | null {
  const range = saveSelectionRange(root);
  return range ? range.start : null;
}

export function saveSelectionRange(root: HTMLElement): TextRange | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start = textOffsetAt(root, range.startContainer, range.startOffset);
  const end = textOffsetAt(root, range.endContainer, range.endOffset);
  if (start == null || end == null) return null;
  return { start, end };
}

export function restoreSelectionRange(root: HTMLElement, range: TextRange) {
  const selection = window.getSelection();
  if (!selection) return;
  const start = pointFromOffset(root, Math.min(range.start, range.end));
  const end = pointFromOffset(root, Math.max(range.start, range.end));
  if (!start || !end) return;
  const next = document.createRange();
  next.setStart(start.node, start.offset);
  next.setEnd(end.node, end.offset);
  selection.removeAllRanges();
  selection.addRange(next);
}

export function restoreCaretOffset(root: HTMLElement, offset: number) {
  restoreSelectionRange(root, { start: offset, end: offset });
}

function firstOffsetOnLine(textNode: Text, lineTop: number): number {
  const length = textNode.data.length;
  if (length === 0) return 0;

  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const range = document.createRange();
    range.setStart(textNode, mid);
    range.setEnd(textNode, Math.min(mid + 1, length));
    const rect = range.getBoundingClientRect();
    if (rect.height === 0 || rect.top + 1 < lineTop) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

type SplitPoint =
  | { kind: "text"; node: Text; offset: number }
  | { kind: "before"; node: Node };

function findSplitAt(root: HTMLElement, pageBottomY: number): SplitPoint | null {
  const scale = visualScale(root);
  const walker = lineWalker(root);
  let node: Node | null;

  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text;
      const range = document.createRange();
      range.selectNodeContents(textNode);
      for (const rect of range.getClientRects()) {
        if (rect.height === 0) continue;
        if (localY(root, rect.bottom, scale) > pageBottomY + 0.5) {
          return {
            kind: "text",
            node: textNode,
            offset: firstOffsetOnLine(textNode, rect.top),
          };
        }
      }
      continue;
    }

    const rect = (node as Element).getBoundingClientRect();
    if (localY(root, rect.bottom, scale) > pageBottomY + 0.5) {
      return { kind: "before", node };
    }
  }

  return null;
}

function insertBreakAt(root: HTMLElement, point: SplitPoint, pageBottom: number) {
  const br = createPageBreak();
  if (point.kind === "before") {
    if (isAtomicBlock(point.node)) {
      const scale = visualScale(root);
      const top = localY(root, (point.node as Element).getBoundingClientRect().top, scale);
      const remaining = pageBottom - top;
      if (remaining > 8) {
        point.node.parentNode?.insertBefore(createPagePush(remaining), point.node);
      }
    }
    point.node.parentNode?.insertBefore(br, point.node);
    return;
  }

  const { node, offset } = point;
  if (offset <= 0) {
    node.parentNode?.insertBefore(br, node);
    return;
  }
  if (offset >= node.data.length) {
    node.parentNode?.insertBefore(br, node.nextSibling);
    return;
  }
  const after = node.splitText(offset);
  after.parentNode?.insertBefore(br, after);
}

function pointKey(point: SplitPoint): string {
  if (point.kind === "before") {
    return `before:${point.node.nodeName}:${point.node.parentNode?.nodeName}`;
  }
  return `text:${point.node.data.slice(0, 12)}:${point.offset}`;
}

export function getContentBottom(root: HTMLElement): number {
  const scale = visualScale(root);
  let max = 0;
  const walker = lineWalker(root);
  let node: Node | null;

  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.height === 0) continue;
        max = Math.max(max, localY(root, rect.bottom, scale));
      }
    } else {
      const rect = (node as Element).getBoundingClientRect();
      if (rect.height === 0) continue;
      max = Math.max(max, localY(root, rect.bottom, scale));
    }
  }

  return max;
}

export function reflowPages(root: HTMLElement): number {
  stripPageBreaks(root);
  const scale = visualScale(root);

  root.querySelectorAll(`[${MANUAL_BREAK_ATTR}]`).forEach((el) => {
    const node = el as HTMLElement;
    node.style.height = "";
    node.classList.add("manual-page-break");
  });

  const seen = new Set<string>();
  let safety = 0;

  while (safety++ < 50) {
    const breaks = root.querySelectorAll(`[${BREAK_ATTR}]`).length;
    const pageBottom = (breaks + 1) * PAGE_CONTENT_HEIGHT + breaks * PAGE_BREAK_HEIGHT;
    const pageStart = breaks * (PAGE_CONTENT_HEIGHT + PAGE_BREAK_HEIGHT);

    let changed = false;
    root.querySelectorAll(`[${MANUAL_BREAK_ATTR}]`).forEach((node) => {
      const el = node as HTMLElement;
      const top = localY(root, el.getBoundingClientRect().top, scale);
      if (top < pageStart - 1 || top >= pageBottom - 1) return;

      const remaining = pageBottom - top;
      if (remaining < 22) {
        if (el.previousElementSibling?.getAttribute(BREAK_ATTR) !== "true") {
          el.parentNode?.insertBefore(createPageBreak(), el);
          changed = true;
        }
        return;
      }

      if (Math.abs((parseFloat(el.style.height) || 0) - remaining) > 1) {
        el.style.height = `${remaining}px`;
        changed = true;
      }
      if (el.nextElementSibling?.getAttribute(BREAK_ATTR) !== "true") {
        el.after(createPageBreak());
        changed = true;
      }
    });
    if (changed) continue;

    if (getContentBottom(root) <= pageBottom + 1) {
      break;
    }

    const point = findSplitAt(root, pageBottom);
    if (!point) break;

    if (point.kind === "before" && isAtomicBlock(point.node)) {
      const top = localY(root, (point.node as Element).getBoundingClientRect().top, scale);
      if (top <= pageStart + 8) break;
    }

    const key = `${breaks}:${pointKey(point)}`;
    if (seen.has(key)) break;
    seen.add(key);

    insertBreakAt(root, point, pageBottom);
    hoistBreaksFromMarks(root);
  }

  hoistBreaksFromMarks(root);
  return root.querySelectorAll(`[${BREAK_ATTR}]`).length + 1;
}

function hoistBreaksFromMarks(root: HTMLElement) {
  root
    .querySelectorAll(`.agent-edit .page-break, .suggestion-add .page-break, .suggestion-del .page-break, .agent-edit .page-push, .suggestion-add .page-push, .suggestion-del .page-push`)
    .forEach((node) => splitMarkAround(node));
}

function splitMarkAround(node: Node) {
  let parent = node.parentElement;
  while (parent?.matches(".agent-edit, .suggestion-add, .suggestion-del")) {
    const after = parent.cloneNode(false) as HTMLElement;
    while (node.nextSibling) after.appendChild(node.nextSibling);
    parent.after(node, after);
    if (!parent.hasChildNodes()) parent.remove();
    if (!after.hasChildNodes()) after.remove();
    parent = node.parentElement;
  }
}

export function isEditorVisuallyEmpty(root: HTMLElement): boolean {
  if (root.querySelector("img, table, .doc-image")) return false;
  if (getPlainText(root).trim().length > 0) return false;
  let blocks = 0;
  for (const child of root.childNodes) {
    if (isBreak(child) || isCaretMark(child)) continue;
    if (child.nodeType === Node.TEXT_NODE && !(child.textContent ?? "").length) continue;
    blocks += 1;
  }
  return blocks <= 1;
}

export function needsReflow(root: HTMLElement): boolean {
  if (root.querySelector(`[${BREAK_ATTR}]`)) return true;
  if (root.querySelector(`[${MANUAL_BREAK_ATTR}]`)) return true;
  return getContentBottom(root) > PAGE_CONTENT_HEIGHT + 1;
}

export function preserveCaret<T>(root: HTMLElement, fn: () => T): T {
  const selection = window.getSelection();
  const focused = root.contains(document.activeElement) || document.activeElement === root;
  let mark: HTMLSpanElement | null = null;

  if (selection && selection.rangeCount > 0 && selection.anchorNode && root.contains(selection.anchorNode)) {
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(true);
    mark = document.createElement("span");
    mark.setAttribute("data-caret-mark", "true");
    mark.setAttribute("aria-hidden", "true");
    mark.style.cssText = "display:inline-block;width:0;height:0;overflow:hidden;line-height:0;";
    range.insertNode(mark);
    if (!mark.nextSibling) {
      mark.after(document.createTextNode(""));
    }
    const after = document.createRange();
    after.setStartAfter(mark);
    after.collapse(true);
    selection.removeAllRanges();
    selection.addRange(after);
  }

  try {
    return fn();
  } finally {
    if (mark) {
      if (focused && mark.isConnected && selection) {
        const range = document.createRange();
        range.setStartAfter(mark);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      mark.remove();
    }
  }
}

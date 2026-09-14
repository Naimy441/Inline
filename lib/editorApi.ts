import { createImageElement } from "@/lib/images";
import { createManualPageBreak, getPlainText, restoreSelectionRange, saveSelectionRange } from "@/lib/pagination";

const SUBSTITUTIONS: [RegExp, string][] = [
  [/\(c\)/gi, "©"],
  [/\(r\)/gi, "®"],
  [/\(tm\)/gi, "™"],
  [/\.\.\./g, "…"],
  [/--/g, "—"],
  [/->/g, "→"],
  [/<-/g, "←"],
];

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function runCommand(editor: HTMLElement, command: string, value?: string) {
  editor.focus();
  document.execCommand(command, false, value);
}

export function setTextColor(editor: HTMLElement, color: string) {
  const next = !color || color === "auto" || color === "inherit" ? "" : color;
  applyInlineStyle(editor, "color", next);
}

export function setHighlightColor(editor: HTMLElement, color: string) {
  const next = !color || color === "transparent" ? "" : color;
  applyInlineStyle(editor, "background-color", next);
}

export function applyFontFamily(editor: HTMLElement, family: string) {
  applyCssToSelection(editor, "font-family", family, () => {
    editor.style.fontFamily = family;
  });
}

export function applyFontSize(editor: HTMLElement, size: string) {
  applyCssToSelection(editor, "font-size", size, () => {
    editor.style.fontSize = size;
  });
}

export function selectionFontMetrics(editor: HTMLElement): { family: string; sizePt: number } {
  const selection = window.getSelection();
  let node: Node | null = selection?.anchorNode ?? editor;
  if (node?.nodeType === Node.TEXT_NODE) node = node.parentElement;
  const el = node instanceof HTMLElement && editor.contains(node) ? node : editor;
  const family = (el.style.fontFamily || getComputedStyle(el).fontFamily)
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");
  const inline = el.style.fontSize;
  const sizePt = inline.endsWith("pt")
    ? Math.round(parseFloat(inline))
    : Math.round((parseFloat(getComputedStyle(el).fontSize) * 72) / 96);
  return { family, sizePt: Number.isFinite(sizePt) && sizePt > 0 ? sizePt : 11 };
}

function applyCssToSelection(
  editor: HTMLElement,
  property: string,
  value: string,
  whenCollapsed: () => void,
) {
  editor.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    whenCollapsed();
    return;
  }
  const saved = saveSelectionRange(editor);
  const range = selection.getRangeAt(0);
  for (const node of textNodesInRange(range)) {
    wrapOrReuseSpan(sliceTextNodeToRange(node, range)).style.setProperty(property, value);
  }
  if (saved) restoreSelectionRange(editor, saved);
}

function wrapOrReuseSpan(node: Text): HTMLElement {
  const parent = node.parentElement;
  const reusable =
    parent instanceof HTMLElement &&
    parent.tagName === "SPAN" &&
    parent.childNodes.length === 1 &&
    (!parent.className || parent.className === "doc-highlight") &&
    ![...parent.attributes].some((attr) => attr.name !== "style" && attr.name !== "class");
  if (reusable) return parent;
  const span = document.createElement("span");
  node.parentNode?.insertBefore(span, node);
  span.appendChild(node);
  return span;
}

function applyInlineStyle(editor: HTMLElement, property: "color" | "background-color", value: string) {
  editor.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;

  if (selection.isCollapsed) {
    document.execCommand("styleWithCSS", false, "true");
    if (property === "color") {
      document.execCommand("foreColor", false, value || "inherit");
    } else if (!document.execCommand("hiliteColor", false, value || "transparent")) {
      document.execCommand("backColor", false, value || "transparent");
    }
    return;
  }

  const saved = saveSelectionRange(editor);
  const range = selection.getRangeAt(0);
  if (!value) {
    clearInlineStyle(editor, range, property);
  } else {
    const nodes = textNodesInRange(range);
    for (const node of nodes) {
      styleTextNode(sliceTextNodeToRange(node, range), property, value);
    }
  }
  if (saved) restoreSelectionRange(editor, saved);
}

function clearInlineStyle(editor: HTMLElement, range: Range, property: "color" | "background-color") {
  const hosts = [...editor.querySelectorAll("span, font, mark")].filter(
    (el): el is HTMLElement =>
      el instanceof HTMLElement && styleHas(el, property) && range.intersectsNode(el),
  );
  for (const el of hosts) {
    if (hostFullySelected(el, range)) styleClear(el, property);
  }

  const nodes = textNodesInRange(range);
  for (const node of [...nodes].reverse()) {
    if (!node.isConnected) continue;
    const slice = sliceTextNodeToRange(node, range);
    removeStyleAround(slice, editor, property);
  }

  for (const el of hosts) {
    if (el.isConnected && styleHas(el, property) && !(el.textContent ?? "").trim()) {
      styleClear(el, property);
    }
  }
}

function hostFullySelected(el: HTMLElement, range: Range) {
  if (el.classList.contains("comment-mark")) return false;
  const contents = document.createRange();
  try {
    contents.selectNodeContents(el);
    return (
      range.compareBoundaryPoints(Range.START_TO_START, contents) <= 0 &&
      range.compareBoundaryPoints(Range.END_TO_END, contents) >= 0
    );
  } catch {
    return range.intersectsNode(el) && !(el.textContent ?? "").trim();
  }
}

function removeStyleAround(node: Text, editor: HTMLElement, property: "color" | "background-color") {
  let el = node.parentElement;
  while (el && el !== editor && editor.contains(el)) {
    const next = el.parentElement;
    if (styleHas(el, property) && isSplittableStyleHost(el)) {
      isolateNodeInAncestor(node, el);
      styleClear(el, property);
    }
    el = next;
  }
}

function isSplittableStyleHost(el: HTMLElement) {
  if (el.classList.contains("comment-mark")) return false;
  return el.tagName === "SPAN" || el.tagName === "FONT" || el.tagName === "MARK";
}

function isolateNodeInAncestor(node: Node, ancestor: HTMLElement) {
  const parent = ancestor.parentNode;
  if (!parent) return;
  let child: Node = node;
  while (child.parentNode && child.parentNode !== ancestor) child = child.parentNode;
  if (child.parentNode !== ancestor) return;

  const before = ancestor.cloneNode(false) as HTMLElement;
  while (ancestor.firstChild && ancestor.firstChild !== child) before.appendChild(ancestor.firstChild);
  if (before.hasChildNodes()) parent.insertBefore(before, ancestor);

  const after = ancestor.cloneNode(false) as HTMLElement;
  while (child.nextSibling) after.appendChild(child.nextSibling);
  if (after.hasChildNodes()) parent.insertBefore(after, ancestor.nextSibling);
}

function textNodesInRange(range: Range): Text[] {
  const ancestor = range.commonAncestorContainer;
  const root = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode : ancestor;
  if (!root) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest("[contenteditable='false']")) return NodeFilter.FILTER_REJECT;
      return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  let current: Node | null;
  while ((current = walker.nextNode())) nodes.push(current as Text);
  return nodes;
}

function sliceTextNodeToRange(node: Text, range: Range): Text {
  const start = node === range.startContainer ? range.startOffset : 0;
  const end = node === range.endContainer ? range.endOffset : node.length;
  if (end < node.length) node.splitText(end);
  if (start > 0) return node.splitText(start);
  return node;
}

function styleTextNode(node: Text, property: "color" | "background-color", value: string) {
  const parent = node.parentElement;
  const reusable =
    parent instanceof HTMLElement &&
    parent.tagName === "SPAN" &&
    parent.childNodes.length === 1 &&
    (!parent.className || parent.className === "doc-highlight") &&
    ![...parent.attributes].some((attr) => attr.name !== "style" && attr.name !== "class");
  const target = reusable
    ? parent
    : (() => {
        const span = document.createElement("span");
        node.parentNode?.insertBefore(span, node);
        span.appendChild(node);
        return span;
      })();
  if (!value) styleClear(target, property);
  else styleSet(target, property, value);
}

function styleHas(el: HTMLElement, property: "color" | "background-color") {
  if (el.classList.contains("comment-mark")) return false;
  if (property === "background-color") {
    return (
      el.classList.contains("doc-highlight") ||
      Boolean(el.style.getPropertyValue("--doc-hl")) ||
      Boolean(el.style.backgroundColor) ||
      Boolean(el.style.background)
    );
  }
  return Boolean(el.style.color);
}

function styleSet(el: HTMLElement, property: "color" | "background-color", value: string) {
  if (property === "background-color") {
    el.classList.add("doc-highlight");
    el.style.setProperty("--doc-hl", value);
    el.style.removeProperty("background-color");
    el.style.removeProperty("background");
  } else {
    el.style.setProperty("color", value);
  }
}

function styleClear(el: HTMLElement, property: "color" | "background-color") {
  if (property === "background-color") {
    el.classList.remove("doc-highlight");
    el.style.removeProperty("--doc-hl");
    el.style.removeProperty("background-color");
    el.style.removeProperty("background");
  } else {
    el.style.removeProperty("color");
  }
  if (!el.getAttribute("style")?.trim()) el.removeAttribute("style");
  if (!el.className) el.removeAttribute("class");
  if (el.tagName === "SPAN" && !el.className && el.attributes.length === 0) {
    el.replaceWith(...el.childNodes);
  }
}

export function insertHtml(editor: HTMLElement, html: string) {
  editor.focus();
  document.execCommand("insertHTML", false, html);
}

export function insertText(editor: HTMLElement, text: string) {
  editor.focus();
  document.execCommand("insertText", false, text);
}

export function selectedText(): string {
  return window.getSelection()?.toString() ?? "";
}

export function selectedHtml(): string {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return "";
  const contents = selection.getRangeAt(0).cloneContents();
  const wrap = document.createElement("div");
  wrap.appendChild(contents);
  return wrap.innerHTML;
}

export function sanitizeCopiedHtml(html: string): string {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  wrap
    .querySelectorAll("[data-page-break], [data-manual-break], [data-caret-mark], .page-break, .manual-page-break")
    .forEach((el) => el.remove());
  unwrapMatches(wrap, ".suggestion-add, .suggestion-del, .comment-mark, mark");
  wrap.querySelectorAll("*").forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    node.style.removeProperty("background");
    node.style.removeProperty("background-color");
    node.style.removeProperty("background-image");
    node.removeAttribute("bgcolor");
    if (node.getAttribute("style")?.trim() === "") node.removeAttribute("style");
  });
  unwrapMatches(wrap, "span:not([class]):not([style])");
  return wrap.innerHTML;
}

export function writeClipboardFromSelection(event: ClipboardEvent, editor: HTMLElement, cut: boolean) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  if (!selection.anchorNode || !editor.contains(selection.anchorNode)) return false;
  event.preventDefault();
  const text = selection.toString();
  const html = sanitizeCopiedHtml(selectedHtml());
  event.clipboardData?.setData("text/plain", text);
  event.clipboardData?.setData(
    "text/html",
    `<html><body><!--StartFragment-->${html}<!--EndFragment--></body></html>`,
  );
  if (cut) {
    selection.deleteFromDocument();
  }
  return true;
}

function unwrapMatches(root: Element, selector: string) {
  root.querySelectorAll(selector).forEach((el) => {
    el.replaceWith(...el.childNodes);
  });
}

export async function pasteRich(editor: HTMLElement) {
  editor.focus();
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      if (item.types.includes("text/html")) {
        const html = await (await item.getType("text/html")).text();
        insertHtml(editor, html);
        return;
      }
    }
    const text = await navigator.clipboard.readText();
    insertText(editor, text);
  } catch {
    document.execCommand("paste");
  }
}

export async function pastePlain(editor: HTMLElement) {
  editor.focus();
  try {
    const text = await navigator.clipboard.readText();
    insertText(editor, text);
  } catch {
    const text = await navigator.clipboard.readText().catch(() => "");
    insertText(editor, text);
  }
}

export function applyCapitalization(editor: HTMLElement, mode: "upper" | "lower" | "title") {
  const text = selectedText();
  if (!text) return;
  const next =
    mode === "upper"
      ? text.toUpperCase()
      : mode === "lower"
        ? text.toLowerCase()
        : text.toLowerCase().replace(/\b([-\w])/g, (char) => char.toUpperCase());
  insertText(editor, next);
}

export function applyBlockStyle(
  editor: HTMLElement,
  style: "normal" | "title" | "subtitle" | "h1" | "h2" | "h3",
) {
  editor.focus();
  const map = {
    normal: "div",
    title: "h1",
    subtitle: "h2",
    h1: "h1",
    h2: "h2",
    h3: "h3",
  } as const;
  document.execCommand("formatBlock", false, map[style]);
  const block = closestBlock(editor);
  if (!block) return;
  block.classList.remove("style-title", "style-subtitle", "style-h1", "style-h2", "style-h3");
  if (style !== "normal") block.classList.add(`style-${style}`);
}

export function setAlignment(editor: HTMLElement, align: "left" | "center" | "right" | "justify") {
  runCommand(editor, `justify${align[0].toUpperCase()}${align.slice(1)}`);
}

export function setLineSpacing(editor: HTMLElement, value: string) {
  editor.style.lineHeight = value;
  editor.querySelectorAll<HTMLElement>("div, p, h1, h2, h3, li").forEach((block) => {
    if (block.closest("[data-page-break],[data-manual-break]")) return;
    block.style.lineHeight = value;
  });
}

export function setColumns(editor: HTMLElement, count: number) {
  editor.style.columnCount = count > 1 ? String(count) : "";
  editor.style.columnGap = count > 1 ? "0.4in" : "";
  editor.style.columnFill = count > 1 ? "auto" : "";
}

export function insertImage(editor: HTMLElement, src: string) {
  editor.focus();
  const wrap = createImageElement(src);
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    editor.appendChild(wrap);
    return;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  range.insertNode(wrap);
  const after = document.createElement("div");
  after.innerHTML = "<br>";
  wrap.after(after);
  const caret = document.createRange();
  caret.setStart(after, 0);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
}

export function insertTable(editor: HTMLElement, rows: number, cols: number) {
  const safeRows = Math.min(12, Math.max(1, rows));
  const safeCols = Math.min(8, Math.max(1, cols));
  const cells = Array.from({ length: safeCols }, () => "<td><br></td>").join("");
  const body = Array.from({ length: safeRows }, () => `<tr>${cells}</tr>`).join("");
  insertHtml(editor, `<table class="doc-table"><tbody>${body}</tbody></table><div><br></div>`);
}

export function insertLink(editor: HTMLElement, url: string, text?: string) {
  editor.focus();
  const href = url.startsWith("http") ? url : `https://${url}`;
  const selection = window.getSelection();
  const selected = selection?.toString() ?? "";
  const hasSelection = Boolean(
    selection &&
      !selection.isCollapsed &&
      selection.anchorNode &&
      editor.contains(selection.anchorNode),
  );

  if (hasSelection) {
    if (text != null && text !== selected) {
      insertHtml(
        editor,
        `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(text)}</a>`,
      );
      return;
    }
    document.execCommand("createLink", false, href);
    const node = selection?.anchorNode;
    const el = node instanceof HTMLElement ? node : node?.parentElement;
    const anchor = el?.closest("a");
    if (anchor) {
      anchor.setAttribute("target", "_blank");
      anchor.setAttribute("rel", "noreferrer");
    }
    return;
  }

  const label = text || href;
  insertHtml(
    editor,
    `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`,
  );
}

export function insertHorizontalLine(editor: HTMLElement) {
  insertHtml(editor, "<hr /><div><br></div>");
}

export function insertPageBreak(editor: HTMLElement) {
  editor.focus();
  const breakEl = createManualPageBreak();
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    editor.appendChild(breakEl);
    return;
  }
  const range = selection.getRangeAt(0);
  range.collapse(false);
  range.insertNode(breakEl);
  const after = document.createElement("div");
  after.innerHTML = "<br>";
  breakEl.after(after);
  const caret = document.createRange();
  caret.setStart(after, 0);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
}

export function insertTab(editor: HTMLElement) {
  insertHtml(editor, '<span class="tab-char">\u0009</span>');
}

export function handleTab(editor: HTMLElement, shiftKey = false) {
  const selection = window.getSelection();
  const hasRange =
    Boolean(selection && !selection.isCollapsed && selection.anchorNode && editor.contains(selection.anchorNode));
  if (shiftKey || hasRange) {
    indentBlocks(editor, shiftKey ? -1 : 1);
    return;
  }
  insertTab(editor);
}

export function indentBlocks(editor: HTMLElement, direction: 1 | -1) {
  editor.focus({ preventScroll: true });
  const blocks = blocksInSelection(editor);
  if (blocks.length === 0) return;

  const listItems = blocks
    .map((block) => block.closest("li"))
    .filter((item): item is HTMLLIElement => item instanceof HTMLLIElement);
  if (listItems.length === blocks.length) {
    document.execCommand(direction > 0 ? "indent" : "outdent");
    return;
  }

  const saved = saveSelectionRange(editor);
  for (const block of blocks) {
    if (block.closest("[data-page-break],[data-manual-break]")) continue;
    const current = parseIndentInches(block);
    const next = Math.max(0, Math.min(4, Math.round((current + direction * 0.5) * 100) / 100));
    block.style.marginLeft = next ? `${next}in` : "";
  }
  if (saved) restoreSelectionRange(editor, saved);
}

export function wrapSelectionMark(editor: HTMLElement, id: string, quote: string) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  if (!editor.contains(selection.anchorNode)) return false;
  const mark = document.createElement("mark");
  mark.className = "comment-mark";
  mark.dataset.commentId = id;
  mark.title = quote;
  try {
    selection.getRangeAt(0).surroundContents(mark);
  } catch {
    const range = selection.getRangeAt(0);
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
  }
  return true;
}

export function findNext(editor: HTMLElement, query: string): boolean {
  const match = locate(editor, query);
  if (!match) return false;
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(match);
  match.startContainer.parentElement?.scrollIntoView({ block: "center" });
  return true;
}

export function replaceCurrent(editor: HTMLElement, query: string, replacement: string): boolean {
  const current = selectedText();
  if (current.toLowerCase() === query.toLowerCase()) {
    insertText(editor, replacement);
    return true;
  }
  if (!findNext(editor, query)) return false;
  insertText(editor, replacement);
  return true;
}

export function replaceAll(editor: HTMLElement, query: string, replacement: string): number {
  if (!query) return 0;
  const matches = locateAll(editor, query);
  const selection = window.getSelection();
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    selection?.removeAllRanges();
    selection?.addRange(matches[index]);
    insertText(editor, replacement);
  }
  return matches.length;
}

export function applySubstitutionsNearCaret(editor: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed || !selection.anchorNode) return;
  const node = selection.anchorNode;
  if (node.nodeType !== Node.TEXT_NODE) return;
  const textNode = node as Text;
  const offset = selection.anchorOffset;
  const before = textNode.data.slice(0, offset);
  for (const [pattern, replacement] of SUBSTITUTIONS) {
    const match = before.match(new RegExp(`${pattern.source}$`, pattern.flags.replace("g", "")));
    if (!match || match.index == null) continue;
    const from = match.index;
    const range = document.createRange();
    range.setStart(textNode, from);
    range.setEnd(textNode, offset);
    selection.removeAllRanges();
    selection.addRange(range);
    insertText(editor, replacement);
    return;
  }
}

export function applySubstitutionsAll(editor: HTMLElement) {
  const html = editor.innerHTML;
  let next = html;
  for (const [pattern, replacement] of SUBSTITUTIONS) {
    next = next.replace(pattern, replacement);
  }
  if (next !== html) editor.innerHTML = next;
}

export function paragraphCount(editor: HTMLElement): number {
  const blocks = [...editor.querySelectorAll("div, p, h1, h2, h3, li")].filter((el) => {
    if (el.closest("[data-page-break],[data-manual-break]")) return false;
    return (el.textContent ?? "").trim().length > 0;
  });
  return Math.max(blocks.length, getPlainText(editor).trim() ? 1 : 0);
}

export function suggestionInsert(editor: HTMLElement, text: string) {
  insertHtml(editor, `<span class="suggestion-add">${escapeHtml(text)}</span>`);
}

export function suggestionDelete(editor: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  if (selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    if (range.startOffset === 0) return false;
    range.setStart(range.startContainer, range.startOffset - 1);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  const deleted = selectedText();
  if (!deleted) return false;
  insertHtml(editor, `<span class="suggestion-del">${escapeHtml(deleted)}</span>`);
  return true;
}

export function toggleList(editor: HTMLElement, type: "ul" | "ol", variant?: "dash") {
  editor.focus();
  document.execCommand(type === "ol" ? "insertOrderedList" : "insertUnorderedList");
  if (type === "ul" && variant === "dash") {
    const list = closestList(editor);
    list?.classList.add("dash-list");
  }
}

export function maybeConvertMarkdownList(editor: HTMLElement, key: string): boolean {
  if (key !== "Enter" && key !== " ") return false;
  const block = closestBlock(editor) ?? (isListTrigger(editor.innerText) ? editor : null);
  if (!block || (block !== editor && block.closest("li, table"))) return false;
  const text = (block.innerText || "").replace(/\u00a0/g, " ").replace(/\n/g, "");
  const trimmed = text.trim();
  const numbered = trimmed === "1" || trimmed === "1.";
  const dash = trimmed === "-";
  if (key === " " && trimmed !== "1." && trimmed !== "-") return false;
  if (!numbered && !dash) return false;

  if (block === editor) {
    editor.innerHTML = "<div><br></div>";
    const first = editor.firstElementChild as HTMLElement | null;
    if (first) placeCaret(first);
  } else {
    block.innerHTML = "<br>";
    placeCaret(block);
  }
  toggleList(editor, numbered ? "ol" : "ul", dash ? "dash" : undefined);
  return true;
}

function isListTrigger(value: string): boolean {
  const trimmed = value.replace(/\u00a0/g, " ").replace(/\n/g, "").trim();
  return trimmed === "1" || trimmed === "1." || trimmed === "-";
}

function placeCaret(block: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(block);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function closestList(editor: HTMLElement): HTMLElement | null {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  if (!node || !editor.contains(node)) return null;
  const el = node instanceof HTMLElement ? node : node.parentElement;
  return el?.closest("ul, ol") as HTMLElement | null;
}

function locateAll(editor: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentElement?.closest("[data-page-break],[data-manual-break]")) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? "";
    const lower = text.toLowerCase();
    let start = 0;
    while (start < lower.length) {
      const index = lower.indexOf(needle, start);
      if (index === -1) break;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + query.length);
      ranges.push(range);
      start = index + needle.length;
    }
  }
  return ranges;
}

function locate(editor: HTMLElement, query: string): Range | null {
  const needle = query.toLowerCase();
  if (!needle) return null;
  const selection = window.getSelection();
  let passed = false;
  const current = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentElement?.closest("[data-page-break],[data-manual-break]")) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.textContent ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? "";
    const lower = text.toLowerCase();
    let start = 0;
    while (start < lower.length) {
      const index = lower.indexOf(needle, start);
      if (index === -1) break;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + query.length);
      if (current && !passed) {
        if (range.compareBoundaryPoints(Range.END_TO_END, current) <= 0) {
          start = index + 1;
          continue;
        }
        passed = true;
      }
      return range;
    }
  }

  if (current) {
    selection?.removeAllRanges();
    return locate(editor, query);
  }
  return null;
}

function closestBlock(editor: HTMLElement): HTMLElement | null {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  if (!node || !editor.contains(node)) return null;
  const el = node instanceof HTMLElement ? node : node.parentElement;
  const found = el?.closest("div, p, h1, h2, h3, li") as HTMLElement | null;
  if (!found || found === editor) return null;
  return found;
}

function blocksInSelection(editor: HTMLElement): HTMLElement[] {
  ensureParagraphBlocks(editor);
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    const block = closestBlock(editor);
    return block ? [block] : [];
  }
  const range = selection.getRangeAt(0);
  const blocks = [...editor.querySelectorAll<HTMLElement>("div, p, h1, h2, h3, li")].filter((block) => {
    if (block === editor) return false;
    if (block.closest("[data-page-break],[data-manual-break]")) return false;
    return range.intersectsNode(block);
  });
  const leaves = blocks.filter((block) => !blocks.some((other) => other !== block && block.contains(other)));
  if (leaves.length > 0) return leaves;
  const fallback = closestBlock(editor);
  return fallback ? [fallback] : [];
}

function ensureParagraphBlocks(editor: HTMLElement) {
  const hasBlock = [...editor.children].some((child) =>
    /^(DIV|P|H1|H2|H3|UL|OL|TABLE)$/.test(child.nodeName),
  );
  if (hasBlock || editor.childNodes.length === 0) return;
  const saved = saveSelectionRange(editor);
  const wrap = document.createElement("div");
  while (editor.firstChild) wrap.appendChild(editor.firstChild);
  editor.appendChild(wrap);
  if (saved) restoreSelectionRange(editor, saved);
}

function parseIndentInches(block: HTMLElement) {
  const raw = block.style.marginLeft.trim();
  if (!raw) return 0;
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return 0;
  if (raw.endsWith("in")) return value;
  if (raw.endsWith("px")) return value / 96;
  return 0;
}

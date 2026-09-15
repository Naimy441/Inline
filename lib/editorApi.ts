import { createImageElement } from "@/lib/images";
import { tidyBrokenParagraphs } from "@/lib/editorTidy";
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
  if (tryExec(editor, "insertHTML", html)) return;
  insertFragment(editor, html);
}

export function insertText(editor: HTMLElement, text: string) {
  editor.focus();
  if (tryExec(editor, "insertText", text)) return;
  insertFragment(editor, escapeHtml(text).replace(/\n/g, "<br>"));
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

export type BlockStyle = "normal" | "title" | "subtitle" | "h1" | "h2" | "h3";
export type ParagraphIndent = "none" | "first-line" | "hanging";

const BLOCK_STYLE_CLASSES = ["style-title", "style-subtitle", "style-h1", "style-h2", "style-h3"] as const;
const INDENT_CLASSES = ["indent-first", "indent-hanging", "mla-indent", "mla-hanging"] as const;

export function applyBlockStyle(editor: HTMLElement, style: BlockStyle) {
  editor.focus();
  const selected = (() => {
    const blocks = blocksInSelection(editor);
    return blocks.length ? blocks : [closestBlock(editor)].filter((block): block is HTMLElement => Boolean(block));
  })();
  const map = {
    normal: "div",
    title: "h1",
    subtitle: "h2",
    h1: "h1",
    h2: "h2",
    h3: "h3",
  } as const;
  tryExec(editor, "formatBlock", map[style]);
  for (const block of selected) {
    const next = replaceBlockTag(block, map[style]);
    for (const cls of BLOCK_STYLE_CLASSES) next.classList.remove(cls);
    if (style !== "normal") next.classList.add(`style-${style}`);
  }
}

export function applyParagraphIndent(
  editor: HTMLElement,
  kind: ParagraphIndent,
  options?: { following?: boolean; scope?: "selection" | "body" | "bibliography" },
) {
  editor.focus();
  if (options?.scope === "body" || options?.scope === "bibliography") {
    tidyBrokenParagraphs(editor);
    for (const block of indentScopeBlocks(editor, options.scope)) applyIndentToBlock(block, kind);
    return;
  }
  const selected = (() => {
    const blocks = blocksInSelection(editor);
    return blocks.length ? blocks : [closestBlock(editor)].filter((block): block is HTMLElement => Boolean(block));
  })();
  const targets = options?.following && selected[0]
    ? blocksThroughNextHeading(editor, selected[0])
    : selected;
  for (const block of targets) applyIndentToBlock(block, kind);
}

export function applyPaperStyle(editor: HTMLElement, preset: "mla" | "apa" | "letter") {
  const family = '"Times New Roman", Times, serif';
  const size = "12pt";
  const spacing = preset === "letter" ? "1.15" : "2";
  editor.style.fontFamily = family;
  editor.style.fontSize = size;
  setLineSpacing(editor, spacing);
  editor.querySelectorAll<HTMLElement>("div, p, h1, h2, h3, li").forEach((block) => {
    if (block.closest("[data-page-break],[data-manual-break]")) return;
    block.style.fontFamily = family;
    block.style.fontSize = size;
  });
}

export function selectionBlockStyle(editor: HTMLElement): "normal" | "title" | "subtitle" | "h1" | "h2" | "h3" {
  const block = closestBlock(editor);
  if (!block) return "normal";
  if (block.classList.contains("style-title")) return "title";
  if (block.classList.contains("style-subtitle")) return "subtitle";
  if (block.classList.contains("style-h1")) return "h1";
  if (block.classList.contains("style-h2")) return "h2";
  if (block.classList.contains("style-h3")) return "h3";
  if (block.tagName === "H1") return "h1";
  if (block.tagName === "H2") return "h2";
  if (block.tagName === "H3") return "h3";
  return "normal";
}

export function setAlignment(editor: HTMLElement, align: "left" | "center" | "right" | "justify") {
  editor.focus();
  wrapOrphanText(editor);
  tryExec(editor, `justify${align[0].toUpperCase()}${align.slice(1)}`);
  const blocks = blocksInSelection(editor);
  const fallback = closestBlock(editor);
  const targets = blocks.length ? blocks : fallback ? [fallback] : [];
  for (const block of targets) {
    if (block === editor || block.closest("[data-page-break],[data-manual-break]")) continue;
    block.style.textAlign = align;
  }
  if (!targets.length) editor.style.textAlign = align;
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

export function insertTable(editor: HTMLElement, rows: number, cols: number, cells?: string[][]) {
  const grid = normalizeTableGrid(rows, cols, cells);
  if (cells?.length) {
    const existing = tableNearCaret(editor);
    if (existing && tableIsEmpty(existing)) {
      writeTableGrid(existing, grid);
      return;
    }
  }
  placeCaretOutsideTable(editor);
  insertHtml(editor, `${tableMarkup(grid)}<div><br></div>`);
}

function normalizeTableGrid(rows: number, cols: number, cells?: string[][]) {
  const rowCount = Math.min(12, Math.max(1, cells?.length || rows || 2));
  const colCount = Math.min(
    8,
    Math.max(1, cells?.reduce((max, row) => Math.max(max, row.length), 0) || cols || 2),
  );
  return Array.from({ length: rowCount }, (_, row) =>
    Array.from({ length: colCount }, (_, col) => cells?.[row]?.[col] ?? ""),
  );
}

function tableMarkup(grid: string[][]) {
  const body = grid
    .map((row) => `<tr>${row.map((cell) => `<td>${cellMarkup(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="doc-table"><tbody>${body}</tbody></table>`;
}

function cellMarkup(value: string) {
  const text = value.trim();
  return text ? escapeHtml(text).replace(/\n/g, "<br>") : "<br>";
}

function tableIsEmpty(table: HTMLTableElement) {
  return ![...table.querySelectorAll("td, th")].some((cell) => (cell.textContent ?? "").trim());
}

function writeTableGrid(table: HTMLTableElement, grid: string[][]) {
  const body = document.createElement("tbody");
  for (const row of grid) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      const text = cell.trim();
      if (text) td.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
      else td.appendChild(document.createElement("br"));
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  const current = table.tBodies[0];
  if (current) current.replaceWith(body);
  else {
    table.querySelector("thead")?.remove();
    table.appendChild(body);
  }
}

function tableNearCaret(editor: HTMLElement): HTMLTableElement | null {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  if (!node || !editor.contains(node)) return null;
  const el = node instanceof Element ? node : node.parentElement;
  if (!el) return null;
  const inside = el.closest("table");
  if (inside instanceof HTMLTableElement && editor.contains(inside)) return inside;
  let current: Element | null = el;
  while (current && current !== editor) {
    const nested = [...current.children].find((child) => child.tagName === "TABLE");
    if (nested instanceof HTMLTableElement) return nested;
    if (current.nextElementSibling?.tagName === "TABLE") return current.nextElementSibling as HTMLTableElement;
    if (current.previousElementSibling?.tagName === "TABLE") return current.previousElementSibling as HTMLTableElement;
    current = current.parentElement;
  }
  return null;
}

function placeCaretOutsideTable(editor: HTMLElement) {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  if (!node || !editor.contains(node)) return;
  const el = node instanceof Element ? node : node.parentElement;
  const table = el?.closest("table");
  if (!(table instanceof HTMLTableElement) || !editor.contains(table)) return;
  const caret = document.createRange();
  caret.setStartAfter(table);
  caret.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(caret);
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
    if (tryExec(editor, "createLink", href)) {
      const node = selection?.anchorNode;
      const el = node instanceof HTMLElement ? node : node?.parentElement;
      const anchor = el?.closest("a");
      if (anchor) {
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noreferrer");
      }
      return;
    }
    insertHtml(
      editor,
      `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(selected)}</a>`,
    );
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
  const anchor = selection?.anchorNode;
  const host = anchor instanceof Element ? anchor : anchor?.parentElement;
  const table = host?.closest("table");
  if (table instanceof HTMLTableElement && editor.contains(table)) {
    table.after(breakEl);
    placeCaretAfterBreak(breakEl, selection);
    return;
  }
  if (!selection || selection.rangeCount === 0) {
    editor.appendChild(breakEl);
    return;
  }
  const range = selection.getRangeAt(0);
  range.collapse(false);
  range.insertNode(breakEl);
  placeCaretAfterBreak(breakEl, selection);
}

function placeCaretAfterBreak(breakEl: HTMLElement, selection: Selection | null) {
  const after = document.createElement("div");
  after.innerHTML = "<br>";
  breakEl.after(after);
  if (!selection) return;
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
    .filter((item): item is HTMLLIElement => item instanceof HTMLElement && item.tagName === "LI");
  if (listItems.length === blocks.length) {
    const nestedBefore = editor.querySelectorAll("ul ul, ol ol, ul ol, ol ul").length;
    tryExec(editor, direction > 0 ? "indent" : "outdent");
    const nestedAfter = editor.querySelectorAll("ul ul, ol ol, ul ol, ol ul").length;
    if (nestedAfter !== nestedBefore) return;
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

export function findAllRanges(editor: HTMLElement, query: string): Range[] {
  if (!query.trim()) return [];
  return locateAll(editor, query);
}

export function selectRange(editor: HTMLElement, range: Range) {
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  const host = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  if (host && typeof host.scrollIntoView === "function") {
    host.scrollIntoView({ block: "center", inline: "nearest" });
  }
}

const FIND_MATCH = "inline-find";
const FIND_CURRENT = "inline-find-current";

export function highlightFind(ranges: Range[], currentIndex = 0) {
  clearFindHighlights();
  const HighlightCtor = (globalThis as { Highlight?: new (...items: Range[]) => Highlight }).Highlight;
  const highlights = typeof CSS !== "undefined" ? CSS.highlights : undefined;
  if (!HighlightCtor || !highlights) return;
  if (ranges.length) highlights.set(FIND_MATCH, new HighlightCtor(...ranges));
  const current = ranges[currentIndex];
  if (current) highlights.set(FIND_CURRENT, new HighlightCtor(current));
}

export function clearFindHighlights() {
  const highlights = typeof CSS !== "undefined" ? CSS.highlights : undefined;
  highlights?.delete(FIND_MATCH);
  highlights?.delete(FIND_CURRENT);
}

export function findNext(editor: HTMLElement, query: string): boolean {
  const match = locate(editor, query);
  if (!match) return false;
  selectRange(editor, match);
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
  insertHtml(editor, `<span class="suggestion-add" spellcheck="false">${escapeHtml(text)}</span>`);
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
  insertHtml(editor, `<span class="suggestion-del" spellcheck="false">${escapeHtml(deleted)}</span>`);
  return true;
}

export function toggleInlineFormat(editor: HTMLElement, kind: "bold" | "italic" | "underline") {
  editor.focus();
  if (tryExec(editor, kind)) return;
  const tag = kind === "bold" ? "strong" : kind === "italic" ? "em" : "u";
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const el = document.createElement(tag);
  try {
    range.surroundContents(el);
  } catch {
    el.appendChild(range.extractContents());
    range.insertNode(el);
  }
}

export function toggleList(editor: HTMLElement, type: "ul" | "ol", variant?: "dash") {
  editor.focus();
  const before = editor.querySelectorAll(type).length;
  tryExec(editor, type === "ol" ? "insertOrderedList" : "insertUnorderedList");
  const after = editor.querySelectorAll(type).length;
  if (after === before) {
    const blocks = blocksInSelection(editor);
    const list = blocks[0]?.closest("ul, ol") as HTMLElement | null;
    const same =
      list &&
      blocks.every((block) => block.closest("ul, ol") === list) &&
      list.tagName === (type === "ol" ? "OL" : "UL");
    if (same && list) unwrapList(list);
    else if (blocks.length) wrapBlocksInList(editor, blocks, type, variant);
    else {
      ensureParagraphBlocks(editor);
      const fallback = [...editor.querySelectorAll<HTMLElement>("div, p, h1, h2, h3")].filter(
        (el) => el.parentElement === editor,
      );
      if (fallback.length) wrapBlocksInList(editor, fallback, type, variant);
    }
  }
  if (type === "ul" && variant === "dash") {
    const list = closestList(editor) ?? [...editor.querySelectorAll("ul")].at(-1);
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

function applyIndentToBlock(block: HTMLElement, kind: ParagraphIndent) {
  for (const cls of INDENT_CLASSES) block.classList.remove(cls);
  if (kind === "first-line") {
    block.classList.add("indent-first");
    block.style.textIndent = "0.5in";
    if (block.style.paddingLeft === "0.5in") block.style.paddingLeft = "";
    return;
  }
  if (kind === "hanging") {
    block.classList.add("indent-hanging");
    block.style.textIndent = "-0.5in";
    block.style.paddingLeft = "0.5in";
    return;
  }
  block.style.textIndent = "";
  if (block.style.paddingLeft === "0.5in") block.style.paddingLeft = "";
}

function blockPlainText(block: HTMLElement) {
  return (block.innerText || block.textContent || "").replace(/\s+/g, " ").trim();
}

function looksLikeHeadingBlock(block: HTMLElement) {
  const text = blockPlainText(block);
  if (!text) return false;
  if (/^h[1-3]$/i.test(block.tagName) || /style-(title|subtitle|h1|h2|h3)/.test(block.className)) return true;
  const align = (block.style.textAlign || block.getAttribute("align") || "").toLowerCase();
  if (align === "center" && text.length < 90) return true;
  return text.length < 90 && /^(#{1,3}\s|[A-Z0-9].{0,70})$/.test(text) && !/[.!?]$/.test(text);
}

function looksLikeBibliographyHeading(block: HTMLElement) {
  return /^(works cited|references|bibliography|works consulted)$/i.test(blockPlainText(block));
}

function indentScopeBlocks(editor: HTMLElement, scope: "body" | "bibliography") {
  const all = topLevelBlocks(editor);
  const bibIdx = all.findIndex((block) => looksLikeBibliographyHeading(block));
  const slice = scope === "bibliography"
    ? bibIdx >= 0 ? all.slice(bibIdx + 1) : all
    : all.slice(0, bibIdx >= 0 ? bibIdx : all.length);
  return slice.filter((block) => blockPlainText(block) && !looksLikeHeadingBlock(block));
}

function topLevelBlocks(editor: HTMLElement) {
  const blocks = [...editor.querySelectorAll<HTMLElement>("div, p, h1, h2, h3")].filter((block) => {
    if (block === editor) return false;
    return !block.closest("[data-page-break],[data-manual-break]");
  });
  return blocks.filter((block) => !blocks.some((other) => other !== block && other.contains(block)));
}

function blocksThroughNextHeading(editor: HTMLElement, start: HTMLElement) {
  const all = topLevelBlocks(editor);
  const startIdx = all.indexOf(start);
  if (startIdx < 0) return [start];
  const startHeading = looksLikeHeadingBlock(start);
  const targets: HTMLElement[] = [];
  for (let index = startIdx + (startHeading ? 1 : 0); index < all.length; index += 1) {
    const block = all[index];
    if (!block) continue;
    if (looksLikeHeadingBlock(block)) {
      if (targets.length) break;
      continue;
    }
    targets.push(block);
  }
  return targets.length ? targets : startHeading ? [] : [start];
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

function wrapOrphanText(editor: HTMLElement) {
  for (const node of [...editor.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent) continue;
    const block = document.createElement("div");
    node.replaceWith(block);
    block.appendChild(node);
  }
}

function ensureParagraphBlocks(editor: HTMLElement) {
  wrapOrphanText(editor);
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

function tryExec(editor: HTMLElement, command: string, value?: string) {
  editor.focus();
  if (typeof document.execCommand !== "function") return false;
  try {
    return Boolean(document.execCommand(command, false, value));
  } catch {
    return false;
  }
}

function insertFragment(editor: HTMLElement, html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const selection = window.getSelection();
  const inEditor = Boolean(
    selection && selection.rangeCount > 0 && selection.anchorNode && editor.contains(selection.anchorNode),
  );
  if (!inEditor) {
    editor.appendChild(template.content);
    return;
  }
  const range = selection!.getRangeAt(0);
  range.deleteContents();
  const last = template.content.lastChild;
  range.insertNode(template.content);
  if (last && selection) {
    const caret = document.createRange();
    caret.setStartAfter(last);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
  }
}

function wrapBlocksInList(editor: HTMLElement, blocks: HTMLElement[], type: "ul" | "ol", variant?: "dash") {
  const list = document.createElement(type);
  if (type === "ul" && variant === "dash") list.classList.add("dash-list");
  const first = blocks[0];
  first.parentNode?.insertBefore(list, first);
  for (const block of blocks) {
    if (block.tagName === "LI") {
      list.appendChild(block);
      continue;
    }
    const li = document.createElement("li");
    while (block.firstChild) li.appendChild(block.firstChild);
    if (!li.childNodes.length) li.appendChild(document.createElement("br"));
    block.remove();
    list.appendChild(li);
  }
  if (!list.parentNode) editor.appendChild(list);
}

function unwrapList(list: HTMLElement) {
  const parent = list.parentNode;
  if (!parent) return;
  for (const li of [...list.querySelectorAll(":scope > li")] as HTMLElement[]) {
    const div = document.createElement("div");
    while (li.firstChild) div.appendChild(li.firstChild);
    if (!div.childNodes.length) div.appendChild(document.createElement("br"));
    parent.insertBefore(div, list);
  }
  list.remove();
}

function replaceBlockTag(block: HTMLElement, tag: string): HTMLElement {
  if (block.tagName.toLowerCase() === tag) return block;
  const next = document.createElement(tag);
  for (const attr of [...block.attributes]) next.setAttribute(attr.name, attr.value);
  while (block.firstChild) next.appendChild(block.firstChild);
  block.replaceWith(next);
  return next;
}

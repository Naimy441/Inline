import type { AgentEditDraft, AgentSelection, PendingEdit } from "@/lib/agent/types";
import { rangeTouchesLock } from "@/lib/locks";
import { getPlainText, getTextIndex, rangeFromTextOffsets, saveSelectionRange } from "@/lib/pagination";

const structuralRestores = new Map<string, {
  parent: Node;
  startIndex: number;
  nodes: HTMLElement[];
  html: string[];
}>();

export function captureAgentSelection(editor: HTMLElement): AgentSelection | null {
  const range = saveSelectionRange(editor, true);
  if (!range || range.start === range.end) return null;
  const live = window.getSelection()?.toString() ?? "";
  return selectionFromOffsets(editor, range.start, range.end, live);
}

export function selectionFromOffsets(
  editor: HTMLElement,
  start: number,
  end: number,
  liveText = "",
): AgentSelection | null {
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  if (from === to) return null;
  const documentText = getTextIndex(editor, true).text;
  const text = (liveText || documentText.slice(from, to)).replace(/\u00a0/g, " ");
  if (!text.trim()) return null;
  const readable = documentText;
  const readableIndex = indexOfLoose(readable, text);
  return {
    text,
    start: from,
    end: to,
    before: (readableIndex >= 0 ? readable.slice(Math.max(0, readableIndex - 240), readableIndex) : documentText.slice(Math.max(0, from - 240), from)).trimStart(),
    after: (readableIndex >= 0
      ? readable.slice(readableIndex + text.length, readableIndex + text.length + 240)
      : documentText.slice(to, to + 240)
    ).trimEnd(),
  };
}

export function sameAgentSelection(a: AgentSelection | null, b: AgentSelection | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.start === b.start && a.end === b.end && a.text === b.text;
}

export function replaceAgentEdits(
  editor: HTMLElement,
  drafts: AgentEditDraft[],
  selection: AgentSelection | null,
  previous: PendingEdit[] = [],
): PendingEdit[] {
  for (const edit of previous) rejectAgentEdit(editor, edit.id);
  return applyAgentEdits(editor, drafts, selection);
}

export function applyAgentEdits(
  editor: HTMLElement,
  drafts: Array<{ find: string; replace: string; reason?: string; operation?: "replace" | "insert" | "delete"; occurrence?: number }>,
  selection: AgentSelection | null,
): PendingEdit[] {
  ensureBlockStructure(editor);
  const prepared = coalesceAdjacentDrafts(editor, drafts).map((draft) => ({
    ...draft,
    id: crypto.randomUUID(),
    status: "pending" as const,
  }));

  const edits = prepared.map((edit) => {
    if (applyOneEdit(editor, edit, selection)) return edit;
    return { ...edit, status: "missed" as const };
  });
  settleAgentEdits(editor);
  return edits;
}

export function applySilentEdits(
  editor: HTMLElement,
  drafts: Array<{ find: string; replace: string }>,
  selection: AgentSelection | null,
) {
  const edits = applyAgentEdits(editor, drafts, selection);
  const applied = edits.filter((edit) => edit.status === "pending");
  for (const edit of applied) acceptAgentEdit(editor, edit.id, { flash: true });
  settleAgentEdits(editor);
  return applied.length;
}

export function clearGrammarFlash(editor: HTMLElement) {
  editor.querySelectorAll(".grammar-flash").forEach((node) => {
    node.replaceWith(...node.childNodes);
  });
}

/**
 * Turn consecutive line-level patches into one range replacement before any
 * DOM mutation. This keeps the page suggestion and chat hunk in sync and
 * prevents a paragraph-sized rewrite from becoming one card per line.
 */
function coalesceAdjacentDrafts(
  editor: HTMLElement,
  drafts: Array<{ find: string; replace: string; reason?: string; operation?: "replace" | "insert" | "delete"; occurrence?: number }>,
) {
  const source = getTextIndex(editor, true).text.replace(/\u00a0/g, " ");
  const positioned = drafts.map((draft, index) => ({
    draft,
    index,
    start: draft.find ? findDraftOccurrence(source, draft.find.replace(/\u00a0/g, " "), draft.occurrence ?? 0) : -1,
  }));
  const merged: typeof drafts = [];
  let lastStart = -1;
  let lastEnd = -1;

  for (const item of positioned) {
    const previous = merged[merged.length - 1];
    const gap = lastEnd >= 0 && item.start >= lastEnd ? source.slice(lastEnd, item.start) : "";
    const canMerge = Boolean(
      previous &&
        lastStart >= 0 &&
        item.start >= lastEnd &&
        gap.includes("\n") &&
        gap.length <= 4 &&
        previous.find &&
        item.draft.find &&
        (previous.operation ?? (previous.replace === "" ? "delete" : "replace")) !== "insert" &&
        (item.draft.operation ?? (item.draft.replace === "" ? "delete" : "replace")) !== "insert",
    );

    if (!canMerge) {
      merged.push(item.draft);
      lastStart = item.start;
      lastEnd = item.start >= 0 ? item.start + item.draft.find.length : -1;
      continue;
    }

    const firstOperation = previous.operation ?? (previous.replace === "" ? "delete" : "replace");
    const secondOperation = item.draft.operation ?? (item.draft.replace === "" ? "delete" : "replace");
    const bothDelete = firstOperation === "delete" && secondOperation === "delete";
    const firstStart = lastStart;
    const combinedEnd = item.start + item.draft.find.length;
    const combinedFind = source.slice(firstStart, combinedEnd);
    const combinedReplace = bothDelete
      ? ""
      : `${previous.replace}${gap}${item.draft.replace}`;
    merged[merged.length - 1] = {
      find: combinedFind,
      replace: combinedReplace,
      operation: bothDelete ? "delete" : "replace",
      reason: [previous.reason, item.draft.reason].filter(Boolean).join(" · ") || "Consecutive document changes",
    };
    lastEnd = combinedEnd;
  }
  return merged;
}

function findDraftOccurrence(haystack: string, needle: string, occurrence: number) {
  if (!needle) return -1;
  const wanted = Math.max(0, Math.floor(occurrence));
  let from = 0;
  for (let index = 0; index <= wanted; index += 1) {
    const hit = haystack.indexOf(needle, from);
    if (hit < 0) return -1;
    if (index === wanted) return hit;
    from = hit + Math.max(1, needle.length);
  }
  return -1;
}

/** Keep agent operations block-addressable even when contenteditable emitted root text nodes. */
function ensureBlockStructure(editor: HTMLElement) {
  for (const node of [...editor.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent) continue;
    const block = document.createElement("div");
    node.replaceWith(block);
    block.appendChild(node);
  }
}

export function acceptAgentEdit(editor: HTMLElement, id: string, options?: { flash?: boolean }) {
  editor.querySelectorAll(`.agent-edit[data-edit-id="${cssId(id)}"]`).forEach((wrap) => {
    structuralRestores.delete(id);
    unwrapAgentEdit(wrap, options?.flash);
  });
}

function unwrapAgentEdit(wrap: Element, flash = false) {
  const add = wrap.querySelector(":scope > .suggestion-add") ?? wrap.querySelector(".suggestion-add");
  const live = liveNodes(add ?? wrap);
  if (wrap.classList.contains("agent-edit-insert")) {
    const block = document.createElement("div");
    if (live.length) block.append(...live);
    else block.append(document.createElement("br"));
    wrap.replaceWith(block);
    return;
  }
  const canFlash =
    flash &&
    live.length > 0 &&
    !wrap.classList.contains("agent-edit-structural") &&
    live.every((node) => node.nodeType === Node.TEXT_NODE || (node instanceof HTMLElement && !/^(DIV|P|H1|H2|H3|UL|OL|LI|TABLE|TR|TD|TH|BLOCKQUOTE)$/.test(node.tagName)));
  if (canFlash) {
    const mark = document.createElement("span");
    mark.className = "grammar-flash";
    mark.append(...live);
    wrap.replaceWith(mark);
    return;
  }
  wrap.replaceWith(...live);
}

export function rejectAgentEdit(editor: HTMLElement, id: string) {
  editor.querySelectorAll(`.agent-edit[data-edit-id="${cssId(id)}"]`).forEach((wrap) => {
    if (wrap.classList.contains("agent-edit-insert")) {
      wrap.remove();
      return;
    }
    if (wrap.classList.contains("agent-edit-structural") && restoreStructuralEdit(editor, wrap)) return;
    const del = wrap.querySelector(".suggestion-del");
    wrap.replaceWith(...(del ? [...del.childNodes] : []));
  });
}

export function jumpToAgentEdit(editor: HTMLElement, id: string) {
  const target = editor.querySelector(`.agent-edit[data-edit-id="${cssId(id)}"]`);
  target?.scrollIntoView({
    block: "center",
    behavior: "smooth",
  });
  highlightAgentEdit(editor, id);
}

export function documentEditIds(editor: HTMLElement) {
  const ids: string[] = [];
  const seen = new Set<string>();
  editor.querySelectorAll<HTMLElement>(".agent-edit").forEach((node) => {
    const id = node.dataset.editId;
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  });
  return ids;
}

export function settleAgentEdits(editor: HTMLElement) {
  [...editor.querySelectorAll<HTMLElement>(".agent-edit .agent-edit")].reverse().forEach((wrap) => {
    unwrapAgentEdit(wrap);
  });
  editor.querySelectorAll(".suggestion-add").forEach((node) => {
    if (node.closest(".agent-edit")) return;
    node.replaceWith(...liveNodes(node));
  });
  editor.querySelectorAll(".suggestion-del").forEach((node) => {
    if (node.closest(".agent-edit")) return;
    node.remove();
  });
}

export function highlightAgentEdit(editor: HTMLElement, id: string | null) {
  editor.querySelectorAll(".agent-edit.is-reviewing").forEach((node) => {
    node.classList.remove("is-reviewing");
  });
  if (!id) return;
  editor.querySelectorAll(`.agent-edit[data-edit-id="${cssId(id)}"]`).forEach((node) => {
    node.classList.add("is-reviewing");
  });
}

function applyOneEdit(
  editor: HTMLElement,
  edit: { id: string; find: string; replace: string; operation?: "replace" | "insert" | "delete"; occurrence?: number },
  selection: AgentSelection | null,
): boolean {
  const operation = edit.operation ?? (edit.replace === "" ? "delete" : edit.find === "" ? "insert" : "replace");
  const replacement = operation === "delete" ? "" : edit.replace;
  const parts = splitParagraphs(replacement);
  if (operation === "insert" && edit.find === "") {
    insertParagraphsAfter(editor, editor.lastElementChild ?? editor, edit.id, parts.length ? parts : [edit.replace]);
    return parts.length > 0 || Boolean(edit.replace);
  }

  let range = locateEditRange(editor, edit.find, selection, edit.occurrence);
  if (!range || range.collapsed || rangeTouchesLock(range)) return false;
  if (operation === "delete" && /^\s*\n[\s\n]*$/.test(edit.find) && applyBoundaryDeletion(editor, range, edit.id)) {
    return true;
  }
  if (flattenIntersectingEdits(editor, range).length) {
    range = locateEditRange(editor, edit.find, selection, edit.occurrence);
    if (!range || range.collapsed || rangeTouchesLock(range)) return false;
  }

  const firstBlock = blockOf(range.startContainer);
  const lastBlock = blockOf(range.endContainer);
  if (
    firstBlock instanceof HTMLElement &&
    lastBlock instanceof HTMLElement &&
    firstBlock !== lastBlock &&
    firstBlock.parentNode === lastBlock.parentNode
  ) {
    wrapStructuralReplacement(editor, range, edit.id, replacement);
    return true;
  }

  const original = range.toString();
  const first = parts[0] ?? "";
  const rest = parts.slice(1);
  const sameAnchor = normalize(first) === normalize(original) && rest.length > 0;

  if (sameAnchor) {
    const block = blockOf(range.endContainer) ?? editor.lastElementChild ?? editor;
    insertParagraphsAfter(editor, block, edit.id, rest);
    return true;
  }

  wrapReplacement(range, edit.id, first);
  if (rest.length) {
    const mark = editor.querySelector(`.agent-edit[data-edit-id="${cssId(edit.id)}"]`);
    const block = (mark && blockOf(mark)) || editor.lastElementChild || editor;
    insertParagraphsAfter(editor, block, edit.id, rest);
  }
  return true;
}

function locateEditRange(
  editor: HTMLElement,
  find: string,
  selection: AgentSelection | null,
  occurrence = 0,
): Range | null {
  const needle = find.replace(/\u00a0/g, " ");
  if (selection) {
    const selected = selection.text.replace(/\u00a0/g, " ");
    if (normalize(selected) === normalize(needle)) {
      const selectedRange = rangeFromTextOffsets(editor, selection.start, selection.end);
      if (selectedRange && !selectedRange.collapsed) return selectedRange;
    }
  }

  const hit = findInDocument(editor, needle, occurrence);
  return hit ? rangeFromTextOffsets(editor, hit.start, hit.end, true) : null;
}

function findInDocument(root: HTMLElement, needle: string, occurrence = 0): { start: number; end: number } | null {
  const text = getTextIndex(root, true).text.replace(/\u00a0/g, " ");
  const exact = findOccurrence(text, needle, occurrence);
  if (exact >= 0) return { start: exact, end: exact + needle.length };

  const compactNeedle = needle.replace(/\s+/g, "");
  if (!compactNeedle) return null;
  let compact = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (/\s/.test(text[i])) continue;
    map.push(i);
    compact += text[i];
  }
  let at = findOccurrence(compact, compactNeedle, occurrence);
  if (at < 0) at = findOccurrence(compact.toLowerCase(), compactNeedle.toLowerCase(), occurrence);
  if (at < 0 || map[at] == null || map[at + compactNeedle.length - 1] == null) return null;
  return { start: map[at], end: map[at + compactNeedle.length - 1] + 1 };
}

function findOccurrence(haystack: string, needle: string, occurrence: number) {
  const wanted = Math.max(0, Math.floor(occurrence));
  let from = 0;
  for (let index = 0; index <= wanted; index += 1) {
    const hit = haystack.indexOf(needle, from);
    if (hit < 0) return -1;
    if (index === wanted) return hit;
    from = hit + Math.max(1, needle.length);
  }
  return -1;
}

function liveNodes(from: Node | null): Node[] {
  if (!from) return [];
  if (from instanceof Element) {
    if (from.classList.contains("suggestion-del")) return [];
    if (from.classList.contains("suggestion-add") || from.classList.contains("agent-edit")) {
      return [...from.childNodes].flatMap(liveNodes);
    }
  }
  return [from];
}

function flattenIntersectingEdits(editor: HTMLElement, range: Range): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const host =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  const nested = host?.closest<HTMLElement>(".agent-edit");
  if (nested?.dataset.editId) {
    seen.add(nested.dataset.editId);
    ids.push(nested.dataset.editId);
  }
  editor.querySelectorAll<HTMLElement>(".agent-edit").forEach((wrap) => {
    const id = wrap.dataset.editId;
    if (!id || seen.has(id) || !rangeIntersectsNode(range, wrap)) return;
    seen.add(id);
    ids.push(id);
  });
  for (const id of ids) acceptAgentEdit(editor, id);
  return ids;
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  const probe = document.createRange();
  try {
    probe.selectNode(node);
  } catch {
    probe.selectNodeContents(node);
  }
  return range.compareBoundaryPoints(Range.END_TO_START, probe) < 0 && range.compareBoundaryPoints(Range.START_TO_END, probe) > 0;
}

function wrapReplacement(range: Range, id: string, replacement: string) {
  const wrap = document.createElement("span");
  wrap.className = "agent-edit";
  wrap.dataset.editId = id;

  const del = document.createElement("span");
  del.className = "suggestion-del";
  try {
    del.appendChild(range.extractContents());
  } catch {
    del.textContent = range.toString();
    range.deleteContents();
  }

  const add = document.createElement("span");
  add.className = "suggestion-add";
  add.textContent = replacement;
  wrap.append(del, add);
  range.insertNode(wrap);
}

/** Merge two adjacent blocks as a reviewable suggestion when deleting a paragraph break. */
function applyBoundaryDeletion(editor: HTMLElement, range: Range, id: string) {
  const first = blockOf(range.startContainer);
  const second = blockOf(range.endContainer);
  if (!(first instanceof HTMLElement) || !(second instanceof HTMLElement) || first === second) return false;
  if (
    first.closest(".locked-region, [contenteditable='false']") ||
    second.closest(".locked-region, [contenteditable='false']") ||
    first.querySelector(".locked-region, [contenteditable='false']") ||
    second.querySelector(".locked-region, [contenteditable='false']")
  ) return false;
  if (first.parentNode !== second.parentNode) return false;

  const parent = first.parentNode;
  if (!parent) return false;
  const children = [...parent.childNodes];
  const firstIndex = children.indexOf(first);
  const secondIndex = children.indexOf(second);
  if (firstIndex < 0 || secondIndex !== firstIndex + 1) return false;

  const old = document.createElement("div");
  old.className = "suggestion-del";
  old.append(first.cloneNode(true), second.cloneNode(true));

  const merged = first.cloneNode(false) as HTMLElement;
  merged.append(...[...first.childNodes, ...second.childNodes].map((node) => node.cloneNode(true)));
  const added = document.createElement("div");
  added.className = "suggestion-add";
  added.append(merged);

  const wrap = document.createElement("div");
  wrap.className = "agent-edit agent-edit-structural";
  wrap.dataset.editId = id;
  wrap.append(old, added);
  parent.insertBefore(wrap, first);
  first.remove();
  second.remove();
  return true;
}

/** Keep cross-block replacements valid HTML and make Undo restore the exact blocks. */
function wrapStructuralReplacement(editor: HTMLElement, range: Range, id: string, replacement: string) {
  const first = blockOf(range.startContainer);
  const last = blockOf(range.endContainer);
  if (!(first instanceof HTMLElement) || !(last instanceof HTMLElement) || first === last || first.parentNode !== last.parentNode) return;
  const parent = first.parentNode;
  if (!parent) return;
  const children = [...parent.childNodes];
  const start = children.indexOf(first);
  const end = children.indexOf(last);
  if (start < 0 || end < start) return;
  const sourceBlocks = children
    .slice(start, end + 1)
    .filter((node): node is HTMLElement => node instanceof HTMLElement);
  const restoreBlocks = sourceBlocks.map((node) => node.outerHTML);
  structuralRestores.set(id, {
    parent,
    startIndex: start,
    nodes: sourceBlocks,
    html: restoreBlocks,
  });

  const wrap = document.createElement("div");
  wrap.className = "agent-edit agent-edit-structural";
  wrap.dataset.editId = id;
  wrap.dataset.restoreBlocks = JSON.stringify(restoreBlocks);
  const del = document.createElement("div");
  del.className = "suggestion-del";
  del.append(...sourceBlocks.map((node) => node.cloneNode(true)));
  const add = document.createElement("div");
  add.className = "suggestion-add";
  const prefix = cloneRangeContents(first, range.startContainer, range.startOffset, "start");
  const suffix = cloneRangeContents(last, range.endContainer, range.endOffset, "end");
  const lines = replacement ? replacement.split("\n") : [""];
  lines.forEach((line, index) => {
    const block = first.cloneNode(false) as HTMLElement;
    if (index === 0) block.append(prefix.cloneNode(true));
    if (line) block.append(document.createTextNode(line));
    else if (lines.length === 1 && !prefix.textContent && !suffix.textContent) block.append(document.createElement("br"));
    if (index === lines.length - 1) block.append(suffix.cloneNode(true));
    add.append(block);
  });
  wrap.append(del, add);
  parent.insertBefore(wrap, first);
  sourceBlocks.forEach((node) => node.remove());
  if (!editor.contains(wrap)) return;
}

function cloneRangeContents(block: HTMLElement, node: Node, offset: number, side: "start" | "end") {
  const range = document.createRange();
  range.selectNodeContents(block);
  if (side === "start") range.setEnd(node, offset);
  else range.setStart(node, offset);
  return range.cloneContents();
}

function restoreStructuralEdit(editor: HTMLElement, wrap: Element) {
  const id = wrap instanceof HTMLElement ? wrap.dataset.editId : undefined;
  const saved = id ? structuralRestores.get(id) : undefined;
  const raw = wrap instanceof HTMLElement ? wrap.dataset.restoreBlocks : undefined;
  if (saved) {
    const fragment = document.createElement("template");
    fragment.innerHTML = saved.html.join("");
    const current = [...saved.parent.childNodes];
    const liveNodes = saved.nodes.filter((node) => node.isConnected && node.parentNode === saved.parent);
    const index = liveNodes.length ? current.indexOf(liveNodes[0]) : saved.startIndex;
    if (index < 0) return false;
    const count = liveNodes.length || saved.html.length;
    for (const node of current.slice(index, index + count)) node.remove();
    saved.parent.insertBefore(fragment.content, saved.parent.childNodes[index] ?? null);
    structuralRestores.delete(id as string);
    return true;
  }
  if (!raw) return false;
  let blocks: string[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return false;
    blocks = parsed;
  } catch {
    return false;
  }
  const host = closestBlockOutsideMark(wrap, editor);
  const parent = host?.parentNode;
  if (!host || !parent || !blocks.length) return false;
  const fragment = document.createElement("template");
  fragment.innerHTML = blocks.join("");
  const restored = [...fragment.content.childNodes];
  const siblings = [...parent.childNodes];
  const index = siblings.indexOf(host);
  if (index < 0) return false;
  for (const node of siblings.slice(index, index + blocks.length)) node.remove();
  parent.insertBefore(fragment.content, parent.childNodes[index] ?? null);
  return restored.length > 0;
}

function closestBlockOutsideMark(node: Element, editor: HTMLElement) {
  let current = node.parentElement;
  while (current && current !== editor) {
    if (current.matches("div, p, h1, h2, h3, li")) return current;
    current = current.parentElement;
  }
  return null;
}

function insertParagraphsAfter(editor: HTMLElement, anchor: Node, id: string, paragraphs: string[]) {
  let after: Node | null = editor.contains(anchor) && anchor !== editor ? anchor : editor.lastChild;
  for (const para of paragraphs) {
    const insert = document.createElement("div");
    insert.className = "agent-edit agent-edit-insert";
    insert.dataset.editId = id;
    const add = document.createElement("span");
    add.className = "suggestion-add";
    add.textContent = para;
    insert.append(add);
    if (after instanceof Element && editor.contains(after) && after !== editor) after.after(insert);
    else editor.append(insert);
    after = insert;
  }
}

function blockOf(node: Node): Element | null {
  const el = node instanceof Element ? node : node.parentElement;
  return el?.closest("div, p, h1, h2, h3, li") ?? el;
}

function splitParagraphs(text: string) {
  return text
    .split(/\n{2,}/)
    .map((part) => part.replace(/\n/g, " ").trim())
    .filter(Boolean);
}

function indexOfLoose(haystack: string, needle: string) {
  const exact = haystack.indexOf(needle);
  if (exact >= 0) return exact;
  return haystack.replace(/\s+/g, " ").indexOf(needle.replace(/\s+/g, " "));
}

function normalize(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function cssId(id: string) {
  return id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

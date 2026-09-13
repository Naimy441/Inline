import type { AgentSelection, PendingEdit } from "@/lib/agent/types";
import { rangeTouchesLock } from "@/lib/locks";
import { getPlainText, getRawText, rangeFromTextOffsets, saveSelectionRange } from "@/lib/pagination";

export function captureAgentSelection(editor: HTMLElement): AgentSelection | null {
  const range = saveSelectionRange(editor);
  if (!range || range.start === range.end) return null;
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  const raw = getRawText(editor);
  const live = window.getSelection()?.toString() ?? "";
  const text = (live.trim() ? live : raw.slice(start, end)).replace(/\u00a0/g, " ");
  if (!text.trim()) return null;
  const readable = getPlainText(editor, true);
  const readableIndex = indexOfLoose(readable, text);
  return {
    text: text.replace(/\u00a0/g, " "),
    start,
    end,
    before: (readableIndex >= 0 ? readable.slice(Math.max(0, readableIndex - 240), readableIndex) : raw.slice(Math.max(0, start - 240), start)).trimStart(),
    after: (readableIndex >= 0
      ? readable.slice(readableIndex + text.length, readableIndex + text.length + 240)
      : raw.slice(end, end + 240)
    ).trimEnd(),
  };
}

export function replaceAgentEdits(
  editor: HTMLElement,
  drafts: Array<{ find: string; replace: string; reason?: string }>,
  selection: AgentSelection | null,
  previous: PendingEdit[] = [],
): PendingEdit[] {
  for (const edit of previous) rejectAgentEdit(editor, edit.id);
  return applyAgentEdits(editor, drafts, selection);
}

export function applyAgentEdits(
  editor: HTMLElement,
  drafts: Array<{ find: string; replace: string; reason?: string }>,
  selection: AgentSelection | null,
): PendingEdit[] {
  const prepared = drafts.map((draft) => ({
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

export function acceptAgentEdit(editor: HTMLElement, id: string) {
  editor.querySelectorAll(`.agent-edit[data-edit-id="${cssId(id)}"]`).forEach((wrap) => {
    unwrapAgentEdit(wrap);
  });
}

function unwrapAgentEdit(wrap: Element) {
  const add = wrap.querySelector(":scope > .suggestion-add") ?? wrap.querySelector(".suggestion-add");
  const live = liveNodes(add ?? wrap);
  if (wrap.classList.contains("agent-edit-insert")) {
    const block = document.createElement("div");
    if (live.length) block.append(...live);
    else block.append(document.createElement("br"));
    wrap.replaceWith(block);
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
  edit: { id: string; find: string; replace: string },
  selection: AgentSelection | null,
): boolean {
  const parts = splitParagraphs(edit.replace);
    if (!edit.find.trim()) {
    insertParagraphsAfter(editor, editor.lastElementChild ?? editor, edit.id, parts.length ? parts : [edit.replace]);
    return parts.length > 0 || Boolean(edit.replace);
  }

  let range = locateEditRange(editor, edit.find, selection);
  if (!range || range.collapsed || rangeTouchesLock(range)) return false;
  if (flattenIntersectingEdits(editor, range).length) {
    range = locateEditRange(editor, edit.find, selection);
    if (!range || range.collapsed || rangeTouchesLock(range)) return false;
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
): Range | null {
  const needle = find.replace(/\u00a0/g, " ");
  if (selection) {
    const selected = selection.text.replace(/\u00a0/g, " ");
    if (normalize(selected) === normalize(needle)) {
      const selectedRange = rangeFromTextOffsets(editor, selection.start, selection.end);
      if (selectedRange && !selectedRange.collapsed) return selectedRange;
    }
  }

  const hit = findInRaw(editor, needle);
  return hit ? rangeFromTextOffsets(editor, hit.start, hit.end, true) : null;
}

function findInRaw(root: HTMLElement, needle: string): { start: number; end: number } | null {
  const raw = getRawText(root, true);
  const exact = raw.indexOf(needle);
  if (exact >= 0) return { start: exact, end: exact + needle.length };

  const compactNeedle = needle.replace(/\s+/g, "");
  if (!compactNeedle) return null;
  let compact = "";
  const map: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (/\s/.test(raw[i])) continue;
    map.push(i);
    compact += raw[i];
  }
  let at = compact.indexOf(compactNeedle);
  if (at < 0) at = compact.toLowerCase().indexOf(compactNeedle.toLowerCase());
  if (at < 0 || map[at] == null || map[at + compactNeedle.length - 1] == null) return null;
  return { start: map[at], end: map[at + compactNeedle.length - 1] + 1 };
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

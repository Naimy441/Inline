import type { AgentSelection, PendingEdit } from "@/lib/agent/types";
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
  const readable = getPlainText(editor);
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

  return prepared.map((edit) => {
    if (applyOneEdit(editor, edit, selection)) return edit;
    return { ...edit, status: "missed" as const };
  });
}

export function acceptAgentEdit(editor: HTMLElement, id: string) {
  editor.querySelectorAll(`.agent-edit[data-edit-id="${cssId(id)}"]`).forEach((wrap) => {
    const add = wrap.querySelector(".suggestion-add");
    if (wrap.classList.contains("agent-edit-insert")) {
      const block = document.createElement("div");
      if (add) block.append(...add.childNodes);
      else block.append(document.createElement("br"));
      wrap.replaceWith(block);
      return;
    }
    wrap.replaceWith(...(add ? [...add.childNodes] : []));
  });
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
  editor.querySelector(`.agent-edit[data-edit-id="${cssId(id)}"]`)?.scrollIntoView({
    block: "center",
    behavior: "smooth",
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

  const range = locateEditRange(editor, edit.find, selection);
  if (!range || range.collapsed) return false;

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
  return hit ? rangeFromTextOffsets(editor, hit.start, hit.end) : null;
}

function findInRaw(root: HTMLElement, needle: string): { start: number; end: number } | null {
  const raw = getRawText(root);
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
    if (after && editor.contains(after) && after !== editor) after.after(insert);
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

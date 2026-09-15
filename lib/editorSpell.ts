const WORD = /[A-Za-z0-9\u00C0-\u024F'’\-]/;

export type SpellingHit = {
  word: string;
  ignored: boolean;
  inSuggestion: boolean;
};

export function muteSpellcheck(node: HTMLElement) {
  node.spellcheck = false;
}

export function muteSuggestionSpellcheck(editor: HTMLElement) {
  editor.querySelectorAll<HTMLElement>(".agent-edit, .suggestion-add, .suggestion-del").forEach(muteSpellcheck);
}

export function spellingTargetAtPoint(editor: HTMLElement, x: number, y: number): { hit: SpellingHit; range: Range } | null {
  const caret = caretRangeFromPoint(x, y);
  if (!caret || !editor.contains(caret.startContainer)) return null;
  const host = caret.startContainer instanceof Element ? caret.startContainer : caret.startContainer.parentElement;
  if (!host || !editor.contains(host)) return null;
  const ignoredHost = host.closest<HTMLElement>("[data-spell-ignore]");
  if (ignoredHost && editor.contains(ignoredHost)) {
    const range = document.createRange();
    range.selectNode(ignoredHost);
    const word = (ignoredHost.textContent ?? "").replace(/\s+/g, " ").trim();
    if (word.length < 2) return null;
    return {
      hit: { word, ignored: true, inSuggestion: Boolean(host.closest(".agent-edit, .suggestion-add, .suggestion-del")) },
      range,
    };
  }
  const wordRange = wordRangeFromCaret(caret);
  if (!wordRange) return null;
  const word = wordRange.toString().replace(/\s+/g, " ").trim();
  if (word.length < 2) return null;
  return {
    hit: {
      word,
      ignored: false,
      inSuggestion: Boolean(host.closest(".agent-edit, .suggestion-add, .suggestion-del")),
    },
    range: wordRange,
  };
}

export function spellingHitAtPoint(editor: HTMLElement, x: number, y: number): SpellingHit | null {
  return spellingTargetAtPoint(editor, x, y)?.hit ?? null;
}

export function ignoreSpellingRange(editor: HTMLElement, range: Range) {
  if (!editor.contains(range.commonAncestorContainer) && !nodeInEditor(editor, range.startContainer)) return false;
  const ignored = spellIgnoreHost(range);
  if (ignored && editor.contains(ignored)) {
    ignored.replaceWith(...ignored.childNodes);
    return true;
  }
  const host = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  if (!host || host.closest(".agent-edit, .suggestion-add, .suggestion-del")) return false;
  if (range.collapsed) return false;
  const mark = document.createElement("span");
  mark.dataset.spellIgnore = "1";
  muteSpellcheck(mark);
  try {
    range.surroundContents(mark);
  } catch {
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
  }
  return true;
}

export function ignoreSpellingAtPoint(editor: HTMLElement, x: number, y: number) {
  const target = spellingTargetAtPoint(editor, x, y);
  if (!target) return false;
  return ignoreSpellingRange(editor, target.range);
}

function nodeInEditor(editor: HTMLElement, node: Node) {
  return node === editor || editor.contains(node);
}

function spellIgnoreHost(range: Range): HTMLElement | null {
  const start = range.startContainer;
  if (start instanceof HTMLElement && start.matches("[data-spell-ignore]")) return start;
  const parent = start instanceof Element ? start : start.parentElement;
  const closest = parent?.closest<HTMLElement>("[data-spell-ignore]");
  if (closest) return closest;
  if (start instanceof Element) {
    const child = start.childNodes[range.startOffset];
    if (child instanceof HTMLElement && child.matches("[data-spell-ignore]")) return child;
  }
  return null;
}
function caretRangeFromPoint(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof doc.caretRangeFromPoint === "function") {
    return doc.caretRangeFromPoint(x, y);
  }
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (!pos) return null;
  const next = document.createRange();
  next.setStart(pos.offsetNode, pos.offset);
  next.collapse(true);
  return next;
}

function wordRangeFromCaret(caret: Range): Range | null {
  const node = caret.startContainer;
  if (node.nodeType !== Node.TEXT_NODE || !node.textContent) return null;
  const text = node.textContent;
  let start = caret.startOffset;
  let end = caret.startOffset;
  if (start >= text.length) start = text.length - 1;
  if (start < 0 || !WORD.test(text[start] ?? "")) {
    if (start > 0 && WORD.test(text[start - 1] ?? "")) start -= 1;
    else return null;
  }
  while (start > 0 && WORD.test(text[start - 1] ?? "")) start -= 1;
  while (end < text.length && WORD.test(text[end] ?? "")) end += 1;
  if (end <= start) return null;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}

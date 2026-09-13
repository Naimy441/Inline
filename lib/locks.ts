export type LockedRange = {
  id: string;
  text: string;
};

export function wrapLockedRegion(editor: HTMLElement, id: string): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  if (!editor.contains(selection.anchorNode)) return false;
  const existing = selection.anchorNode instanceof Element
    ? selection.anchorNode.closest(".locked-region")
    : selection.anchorNode?.parentElement?.closest(".locked-region");
  if (existing instanceof HTMLElement) {
    unwrapLocked(existing);
    return true;
  }
  const mark = document.createElement("span");
  mark.className = "locked-region";
  mark.dataset.lockId = id;
  mark.title = "Locked from AI edits";
  try {
    selection.getRangeAt(0).surroundContents(mark);
  } catch {
    const range = selection.getRangeAt(0);
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
  }
  return true;
}

export function unlockRegion(editor: HTMLElement, id: string) {
  editor.querySelectorAll(`.locked-region[data-lock-id="${cssId(id)}"]`).forEach((node) => {
    if (node instanceof HTMLElement) unwrapLocked(node);
  });
}

export function listLockedRanges(editor: HTMLElement): LockedRange[] {
  return [...editor.querySelectorAll<HTMLElement>(".locked-region")].map((node) => ({
    id: node.dataset.lockId || "",
    text: (node.textContent || "").replace(/\s+/g, " ").trim(),
  }));
}

export function rangeTouchesLock(range: Range): boolean {
  const root = range.commonAncestorContainer;
  const el = root instanceof Element ? root : root.parentElement;
  if (el?.closest(".locked-region")) return true;
  const editor = el?.closest(".editor");
  if (!editor) return false;
  try {
    for (const node of editor.querySelectorAll(".locked-region")) {
      if (range.intersectsNode(node)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function unwrapLocked(node: HTMLElement) {
  node.replaceWith(...node.childNodes);
}

function cssId(id: string) {
  return id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

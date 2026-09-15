import { isSoftWrapContinuation, isStandaloneHeadingLine } from "@/lib/writing/paragraphs";

/** Rejoin hard-wrapped leftover lines and drop empty heading spacers. */
export function tidyBrokenParagraphs(editor: HTMLElement) {
  dropEmptySpacerBlocks(editor);
  mergeSoftWrappedBlocks(editor);
}

function dropEmptySpacerBlocks(editor: HTMLElement) {
  const blocks = topLevelBlocks(editor);
  if (blocks.length <= 1) return;
  for (const block of blocks) {
    if (block.querySelector("img, table, .doc-image") || block.closest("[data-manual-break]")) continue;
    if (blockPlainText(block)) continue;
    block.remove();
  }
}

function mergeSoftWrappedBlocks(editor: HTMLElement) {
  const blocks = topLevelBlocks(editor);
  for (let index = 1; index < blocks.length; index += 1) {
    const prev = blocks[index - 1];
    const next = blocks[index];
    if (!prev || !next) continue;
    if (isStandaloneHeadingLine(blockPlainText(prev)) || isStandaloneHeadingLine(blockPlainText(next))) continue;
    if (!isSoftWrapContinuation(blockPlainText(prev), blockPlainText(next))) continue;
    const prevText = prev.textContent ?? "";
    const nextText = next.textContent ?? "";
    if (prevText && nextText && !/\s$/.test(prevText) && !/^\s/.test(nextText)) {
      prev.append(document.createTextNode(" "));
    }
    while (next.firstChild) prev.append(next.firstChild);
    next.remove();
    blocks.splice(index, 1);
    index -= 1;
  }
}

function blockPlainText(block: HTMLElement) {
  return (block.innerText || block.textContent || "").replace(/\s+/g, " ").trim();
}

function topLevelBlocks(editor: HTMLElement) {
  const blocks = [...editor.querySelectorAll<HTMLElement>("div, p, h1, h2, h3")].filter((block) => {
    if (block === editor) return false;
    return !block.closest("[data-page-break],[data-manual-break]");
  });
  return blocks.filter((block) => !blocks.some((other) => other !== block && other.contains(block)));
}

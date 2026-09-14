import type { DocumentPageSlice } from "@/lib/agent/types";
import { getTextIndex } from "@/lib/pagination";

export function collectDocumentPages(root: HTMLElement): DocumentPageSlice[] {
  const index = getTextIndex(root, true);
  const text = index.text.replace(/\u00a0/g, " ");
  const breaks = [...root.querySelectorAll("[data-page-break]")];
  if (!breaks.length) {
    return [{ number: 1, start: 0, end: text.length, text }];
  }

  const cuts = [0];
  for (const el of breaks) {
    const offset = offsetAfterNode(el, index);
    if (offset > cuts[cuts.length - 1]) cuts.push(offset);
  }
  if (cuts[cuts.length - 1] < text.length) cuts.push(text.length);

  return cuts.slice(0, -1).map((start, number) => ({
    number: number + 1,
    start,
    end: cuts[number + 1],
    text: text.slice(start, cuts[number + 1]),
  }));
}

function offsetAfterNode(
  breakEl: Element,
  index: ReturnType<typeof getTextIndex>,
) {
  for (const seg of index.segments) {
    const node = seg.kind === "text" ? seg.node : seg.start.node;
    if (breakEl.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
      return seg.textStart;
    }
  }
  return index.text.length;
}

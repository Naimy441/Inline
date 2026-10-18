import type { EditorView } from "prosemirror-view";

const NEAR = 2;

/**
 * A keep-together section with `bleed` paints its background out to the sheet
 * edge. The offsets are the margin, and only on the sides the section already
 * touches, so a section inside a column does not cover its sibling. Text stays
 * in the content box. The paint stops at the sheet, not in the page gap.
 */
export function syncCanvasBleed(view: EditorView) {
  const root = view.dom as HTMLElement;
  const sections = [...root.querySelectorAll<HTMLElement>('[data-canvas="section"]')];
  if (!sections.length) return;
  const sheets = [...(root.closest(".page-stack")?.querySelectorAll<HTMLElement>(".sheet") ?? [])];
  for (const section of sections) {
    if (section.dataset.bleed !== "true") {
      clearBleed(section);
      continue;
    }
    const rect = section.getBoundingClientRect();
    const sheet = sheets.find((candidate) => {
      const box = candidate.getBoundingClientRect();
      const mid = rect.top + Math.min(rect.height / 2, 8);
      return mid >= box.top - 1 && mid <= box.bottom + 1;
    });
    if (!sheet) {
      clearBleed(section);
      continue;
    }
    const sheetRect = sheet.getBoundingClientRect();
    const zoom = sheet.offsetWidth > 0 ? sheetRect.width / sheet.offsetWidth || 1 : 1;
    const header = sheet.querySelector(".sheet-header")?.getBoundingClientRect().height ?? 0;
    const footer = sheet.querySelector(".sheet-footer")?.getBoundingClientRect().height ?? 0;
    const content = root.closest(".page-content")?.getBoundingClientRect();
    const marginLeft = content ? content.left - sheetRect.left : 0;
    const marginRight = content ? sheetRect.right - content.right : 0;
    const contentLeft = sheetRect.left + marginLeft;
    const contentRight = sheetRect.right - marginRight;
    const contentTop = sheetRect.top + header;
    const contentBottom = sheetRect.bottom - footer;
    const at = (edge: number, value: number) => Math.abs(edge - value) <= NEAR * zoom;
    setBleed(section, "left", at(rect.left, contentLeft) ? (rect.left - sheetRect.left) / zoom : 0);
    setBleed(section, "right", at(rect.right, contentRight) ? (sheetRect.right - rect.right) / zoom : 0);
    setBleed(section, "top", at(rect.top, contentTop) ? (rect.top - sheetRect.top) / zoom : 0);
    setBleed(section, "bottom", at(rect.bottom, contentBottom) ? (sheetRect.bottom - rect.bottom) / zoom : 0);
  }
}

function setBleed(section: HTMLElement, side: "left" | "right" | "top" | "bottom", px: number) {
  section.style.setProperty(`--bleed-${side}`, `${Math.max(0, px)}px`);
}

function clearBleed(section: HTMLElement) {
  for (const side of ["left", "right", "top", "bottom"]) section.style.removeProperty(`--bleed-${side}`);
}

import { Plugin } from "prosemirror-state";
import { darkScreenCanvasCss, scopedCanvasCss } from "./styles";

let sequence = 0;
export type CanvasIssue = { id: string; message: string; severity?: "warning" };

export type CanvasBlockBox = {
  id: string;
  page: number;
  toPage: number;
  top: number;
  height: number;
  kind: "break" | "heading" | "block";
};

export type CanvasPageSpace = {
  page: number;
  contentWidth: number;
  contentHeight: number;
  used: number;
  free: number;
};

/** Free space on each page, in CSS pixels of the content box. */
export function canvasPageSpace(blocks: CanvasBlockBox[], pageCount: number, contentWidth: number, contentHeight: number): CanvasPageSpace[] {
  const pages: CanvasPageSpace[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    let used = 0;
    for (const block of blocks) {
      if (block.toPage < page || block.page > page) continue;
      if (block.page < page || block.toPage > page) {
        used = contentHeight;
        break;
      }
      used = Math.max(used, Math.min(contentHeight, Math.max(0, block.top) + Math.max(0, block.height)));
    }
    used = Math.max(0, Math.min(contentHeight, used));
    pages.push({
      page,
      contentWidth: Math.round(contentWidth),
      contentHeight: Math.round(contentHeight),
      used: Math.round(used),
      free: Math.round(Math.max(0, contentHeight - used)),
    });
  }
  return pages;
}

/**
 * Pages that look broken in a way overflow checks miss: a large empty gap,
 * a heading stranded at the bottom, or a last page with only a short block.
 * An intentional page break and a one-page document are left alone.
 */
export function canvasFlowIssues(blocks: CanvasBlockBox[], space: CanvasPageSpace[]): CanvasIssue[] {
  const issues: CanvasIssue[] = [];
  const pageCount = space.length;
  for (const box of space) {
    const hasBreak = blocks.some((block) => block.kind === "break" && block.page === box.page);
    if (box.page < pageCount && !hasBreak && box.free > Math.max(160, box.contentHeight * 0.35)) {
      issues.push({ id: `page-${box.page}`, severity: "warning", message: `Page ${box.page} is mostly empty (${box.free}px free of ${box.contentHeight}px). Later content starts on the next page.` });
    }
    if (box.page < pageCount && !hasBreak) {
      const last = blocks.filter((block) => block.page === box.page && block.kind !== "break").sort((a, b) => a.top - b.top).at(-1);
      if (last?.kind === "heading" && last.top > box.contentHeight * 0.45) {
        issues.push({ id: last.id, severity: "warning", message: `Heading ${last.id} sits in the lower part of page ${box.page}, and the following content starts on the next page.` });
      }
    }
  }
  if (pageCount > 1) {
    const last = space[pageCount - 1];
    const previousHasBreak = blocks.some((block) => block.kind === "break" && block.page === pageCount - 1);
    if (last && !previousHasBreak && last.used < Math.min(140, last.contentHeight * 0.22)) {
      issues.push({ id: `page-${last.page}`, severity: "warning", message: `Page ${last.page} holds only a short block (${last.used}px of ${last.contentHeight}px).` });
    }
  }
  return issues;
}

export function inspectCanvasDom(root: HTMLElement, pageHeight: number): CanvasIssue[] {
  const issues: CanvasIssue[] = [];
  const scale = root.getBoundingClientRect().width / (root.offsetWidth || 1) || 1;
  for (const element of root.querySelectorAll<HTMLElement>("[data-id]")) {
    const id = element.dataset.id!;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    if (element.scrollWidth > element.clientWidth + 3 && element.clientWidth > 0) issues.push({ id, message: "Content overflows its width. Reduce width, padding, or text size." });
    if ((element.dataset.pagination === "keep-together" || element.tagName === "TR") && box.height / scale > pageHeight + 2) issues.push({ id, message: "This indivisible component is taller than a page. Split it into smaller components." });
    if (element.dataset.canvas && element.dataset.pagination === "flow" && !element.parentElement?.closest('[data-pagination="keep-together"]') && (parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) > 0 || !["rgba(0, 0, 0, 0)", "transparent"].includes(style.backgroundColor))) issues.push({ id, message: "A flowing container cannot have padding, borders, or a background. Use keep-together, or decorate individual text blocks." });
  }
  return issues.slice(0, 50);
}

/** Apply scoped design without replacing any contenteditable DOM or selection. */
export function canvasDesignPlugin() {
  return new Plugin({
    view(view) {
      const id = `canvas-${++sequence}`;
      const sheet = document.createElement("style");
      sheet.dataset.canvasStyles = id;
      view.dom.parentElement!.append(sheet);
      let lastCss: string | null = null;
      const update = () => {
        const design = view.state.doc.attrs.canvas;
        if (!design) { view.dom.removeAttribute("data-canvas-root"); sheet.textContent = ""; lastCss = null; return; }
        view.dom.setAttribute("data-canvas-root", id);
        const light = scopedCanvasCss(design.css, id);
        // Screen-only. Print and the light PDF render keep the authored colors above.
        const next = document.documentElement.dataset.theme === "dark" ? `${light}\n${darkScreenCanvasCss(light)}` : light;
        if (lastCss !== next) {
          sheet.textContent = next;
          lastCss = next;
        }
      };
      update();
      const theme = new MutationObserver(update);
      theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      return { update, destroy() { theme.disconnect(); sheet.remove(); } };
    },
  });
}

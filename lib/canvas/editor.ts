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

/** Free space on each page, in CSS pixels of the content box. A page break contributes its own height and does not fill the sheet. */
export function canvasPageSpace(blocks: CanvasBlockBox[], pageCount: number, contentWidth: number, contentHeight: number): CanvasPageSpace[] {
  const pages: CanvasPageSpace[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    let used = 0;
    for (const block of blocks) {
      if (block.toPage < page || block.page > page) continue;
      // The spacer after a PageBreak is empty. Count the marker, not the rest of the page.
      if (block.kind === "break") {
        if (block.page === page) used = Math.max(used, Math.min(contentHeight, Math.max(0, block.top) + Math.max(0, block.height)));
        continue;
      }
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
 * a heading stranded at the bottom, a last page with only a short block, or
 * a page that holds very little before a PageBreak. The page a break starts
 * is left alone. A one-page document is left alone.
 */
export function canvasFlowIssues(blocks: CanvasBlockBox[], space: CanvasPageSpace[]): CanvasIssue[] {
  const issues: CanvasIssue[] = [];
  const pageCount = space.length;
  const shortLimit = (height: number) => Math.min(140, height * 0.22);
  for (const box of space) {
    const hasBreak = blocks.some((block) => block.kind === "break" && block.page === box.page);
    const startedByBreak = blocks.some((block) => block.kind === "break" && block.page === box.page - 1);
    if (hasBreak) {
      const content = blocks.filter((block) => block.page === box.page && block.kind !== "break");
      const before = content.reduce((used, block) => Math.max(used, Math.max(0, block.top) + Math.max(0, block.height)), 0);
      if (before < shortLimit(box.contentHeight)) {
        issues.push({ id: `page-${box.page}`, severity: "warning", message: `Page ${box.page} has very little content before a page break (${Math.round(before)}px of ${box.contentHeight}px).` });
      }
    }
    if (box.page < pageCount && !hasBreak && !startedByBreak && box.free > Math.max(160, box.contentHeight * 0.35)) {
      issues.push({ id: `page-${box.page}`, severity: "warning", message: `Page ${box.page} is mostly empty (${box.free}px free of ${box.contentHeight}px). Later content starts on the next page.` });
    }
    if (box.page < pageCount && !hasBreak && !startedByBreak) {
      const last = blocks.filter((block) => block.page === box.page && block.kind !== "break").sort((a, b) => a.top - b.top).at(-1);
      if (last?.kind === "heading" && last.top > box.contentHeight * 0.45) {
        issues.push({ id: last.id, severity: "warning", message: `Heading ${last.id} sits in the lower part of page ${box.page}, and the following content starts on the next page.` });
      }
    }
  }
  if (pageCount > 1) {
    const last = space[pageCount - 1];
    const previousHasBreak = blocks.some((block) => block.kind === "break" && block.page === pageCount - 1);
    if (last && !previousHasBreak && last.used < shortLimit(last.contentHeight)) {
      issues.push({ id: `page-${last.page}`, severity: "warning", message: `Page ${last.page} holds only a short block (${last.used}px of ${last.contentHeight}px).` });
    }
  }
  return issues;
}

function ownsOverflow(element: HTMLElement, childId: string) {
  if (childId === element.dataset.id) return true;
  for (const node of element.querySelectorAll<HTMLElement>("[data-id]")) {
    if (node.dataset.id !== childId) continue;
    return node.parentElement?.closest("[data-id]") === element;
  }
  return false;
}

/** The child that sticks out of `element`, or the element itself when its scroll box does. */
function overflowOf(element: HTMLElement, axis: "width" | "height", scale: number): { id: string; amount: number } | null {
  const host = element.getBoundingClientRect();
  let amount = 0;
  let id = element.dataset.id || "";
  if (axis === "width" && element.clientWidth > 0) {
    const extra = element.scrollWidth - element.clientWidth;
    const bar = Math.max(0, element.offsetWidth - element.clientWidth);
    const heightExtra = element.clientHeight > 0 ? element.scrollHeight - element.clientHeight : 0;
    // A vertical scrollbar shrinks clientWidth. That is not a width overflow.
    if (extra > 3 && !(heightExtra > 3 && extra <= bar + 4)) amount = extra;
  }
  if (axis === "height" && element.clientHeight > 0) {
    const extra = element.scrollHeight - element.clientHeight;
    if (extra > 3) amount = Math.max(amount, extra);
  }
  for (const node of element.querySelectorAll<HTMLElement>("[data-id]")) {
    if (node === element || node.closest(".page-gap")) continue;
    const box = node.getBoundingClientRect();
    const over = axis === "width"
      ? Math.max(box.right - host.right, host.left - box.left) / scale
      : Math.max(box.bottom - host.bottom, host.top - box.top) / scale;
    if (over > amount && over > 3 && node.dataset.id) {
      amount = over;
      id = node.dataset.id;
    }
  }
  return amount > 3 && id ? { id, amount } : null;
}

export function inspectCanvasDom(root: HTMLElement, pageHeight: number): CanvasIssue[] {
  const issues: CanvasIssue[] = [];
  const scale = root.getBoundingClientRect().width / (root.offsetWidth || 1) || 1;
  for (const element of root.querySelectorAll<HTMLElement>("[data-id]")) {
    if (element.closest(".page-gap")) continue;
    const id = element.dataset.id!;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    for (const axis of ["width", "height"] as const) {
      const overflow = overflowOf(element, axis, scale);
      if (overflow && ownsOverflow(element, overflow.id)) issues.push({ id: overflow.id, message: `${overflow.id} overflows its ${axis} by ${Math.round(overflow.amount)}px.` });
    }
    if ((element.dataset.pagination === "keep-together" || element.tagName === "TR") && box.height / scale > pageHeight + 2) issues.push({ id, message: "This indivisible component is taller than a page. Split it into smaller components." });
    const painted = !["rgba(0, 0, 0, 0)", "transparent"].includes(style.backgroundColor) || (style.backgroundImage && style.backgroundImage !== "none");
    if (element.dataset.canvas && element.dataset.pagination === "flow" && !element.parentElement?.closest('[data-pagination="keep-together"]') && (parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) > 0 || painted)) issues.push({ id, message: "A flowing container cannot have padding, borders, or a background. Use keep-together, or decorate individual text blocks." });
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

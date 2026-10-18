import { Plugin } from "prosemirror-state";
import { darkScreenCanvasCss, scopedCanvasCss } from "./styles";

let sequence = 0;
export type CanvasIssue = { id: string; message: string };

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

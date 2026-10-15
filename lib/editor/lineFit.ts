import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { liveLineBreaks } from "@/lib/doc/lineBreaks";

/**
 * Paragraphs that keep the line breaks of the PDF they were rebuilt from
 * (lib/doc/lineBreaks.ts). Each kept line is spaced to fill the line exactly
 * — its spaces widened or narrowed, as TeX does — so the next word can't
 * fit and the line breaks where it did in the PDF; a break inside a word
 * gets a soft hyphen. The spacing is measured after layout, with the lines
 * laid out unbroken (document.css `.line-measure`), and kept per paragraph
 * until its text, its width or the fonts change.
 */

type Fit = { signature: string; spacing: number[] };
type FitState = { fits: Map<string, Fit>; decorations: DecorationSet };

const key = new PluginKey<FitState>("lineFit");

/** What a paragraph's measured spacing depends on, beyond its width and the fonts. */
const signatureOf = (node: PMNode) => String(node.attrs.lineBreaks);

function hyphen() {
  const el = document.createElement("span");
  el.className = "lf-hyphen";
  el.textContent = "­";
  return el;
}

function decorate(doc: PMNode, fits: Map<string, Fit>) {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const kept = node.attrs.lineBreaks ? liveLineBreaks(node) : null;
    if (!kept) return false;
    const start = pos + 1;
    for (const item of kept.breaks) {
      if (item.hyphen) decorations.push(Decoration.widget(start + item.at, hyphen, { side: -1, key: `lf-${item.at}`, ignoreSelection: true, marks: [] }));
    }
    const fit = node.attrs.id ? fits.get(String(node.attrs.id)) : undefined;
    if (!fit || fit.signature !== signatureOf(node) || fit.spacing.length !== kept.breaks.length) return false;
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "line-fit" }));
    let from = start;
    kept.breaks.forEach((item, index) => {
      const to = start + item.at;
      const spacing = fit.spacing[index]!;
      if (to > from && Number.isFinite(spacing)) decorations.push(Decoration.inline(from, to, { style: `word-spacing: ${spacing.toFixed(3)}px` }));
      from = to;
    });
    return false;
  });
  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

export function lineFitPlugin() {
  return new Plugin<FitState>({
    key,
    state: {
      init: (_config, state) => ({ fits: new Map(), decorations: decorate(state.doc, new Map()) }),
      apply(tr, value, _old, state) {
        const measured = tr.getMeta(key) as Map<string, Fit> | undefined;
        if (measured) {
          const fits = new Map(value.fits);
          for (const [id, fit] of measured) fits.set(id, fit);
          return { fits, decorations: decorate(state.doc, fits) };
        }
        if (!tr.docChanged) return value;
        return { fits: value.fits, decorations: decorate(state.doc, value.fits) };
      },
    },
    props: {
      decorations: (state) => key.getState(state)?.decorations,
    },
    view(view) {
      let frame = 0;
      let fontsVersion = 0;
      const schedule = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          fitLines(view, fontsVersion);
        });
      };
      const fonts = typeof document !== "undefined" ? document.fonts : undefined;
      const onFonts = () => {
        fontsVersion += 1;
        schedule();
      };
      fonts?.addEventListener?.("loadingdone", onFonts);
      let width = 0;
      const resized =
        typeof ResizeObserver !== "undefined"
          ? new ResizeObserver(() => {
              const next = (view.dom as HTMLElement).offsetWidth;
              if (next === width) return;
              width = next;
              schedule();
            })
          : null;
      resized?.observe(view.dom);
      schedule();
      (view.dom as HTMLElement & { fitLinesNow?: () => boolean }).fitLinesNow = () => fitLines(view, fontsVersion);
      return {
        update(updated, previous) {
          if (updated.state.doc !== previous.doc) schedule();
        },
        destroy() {
          if (frame) cancelAnimationFrame(frame);
          fonts?.removeEventListener?.("loadingdone", onFonts);
          resized?.disconnect();
        },
      };
    },
  });
}

/**
 * Measure the spacing of every kept paragraph not yet measured for its
 * current text, width and fonts, and apply it. Returns whether anything was
 * measured (the layout then changes). Called before the pages are pictured or
 * exported, so they never show a paragraph between two fittings.
 */
export function fitLinesNow(view: EditorView) {
  return (view.dom as HTMLElement & { fitLinesNow?: () => boolean }).fitLinesNow?.() ?? false;
}

const done = new WeakMap<EditorView, Map<string, string>>();

function fitLines(view: EditorView, fontsVersion: number) {
  const root = view.dom as HTMLElement;
  if (!root.isConnected || !root.offsetWidth) return false;
  const state = key.getState(view.state);
  if (!state) return false;
  const measuredFor = done.get(view) ?? new Map<string, string>();
  done.set(view, measuredFor);
  const results = new Map<string, Fit>();
  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (!node.attrs.lineBreaks || !node.attrs.id) return false;
    const kept = liveLineBreaks(node);
    if (!kept) return false;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return false;
    const id = String(node.attrs.id);
    const stamp = `${signatureOf(node)}|${dom.clientWidth}|${fontsVersion}`;
    if (measuredFor.get(id) === stamp && state.fits.get(id)?.signature === signatureOf(node)) return false;
    const spacing = measureParagraph(view, node, pos, dom, kept.breaks);
    measuredFor.set(id, stamp);
    if (spacing) results.set(id, { signature: signatureOf(node), spacing });
    return false;
  });
  if (!results.size) return false;
  view.dispatch(view.state.tr.setMeta(key, results).setMeta("addToHistory", false));
  return true;
}

/** Visible spaces (word separators) between two content offsets, outside equations. */
function spacesBetween(node: PMNode, from: number, to: number) {
  let count = 0;
  node.forEach((child, offset) => {
    if (!child.isText || child.marks.some((mark) => mark.type.name === "math")) return;
    const text = child.text!;
    const start = Math.max(from, offset);
    const end = Math.min(to, offset + text.length);
    for (let at = start; at < end; at += 1) {
      const char = text[at - offset];
      if (char === " " || char === " ") count += 1;
    }
  });
  return count;
}

function measureParagraph(view: EditorView, node: PMNode, pos: number, dom: HTMLElement, breaks: Array<{ at: number; hyphen: boolean }>): number[] | null {
  const start = pos + 1;
  const style = getComputedStyle(dom);
  const fontSize = parseFloat(style.fontSize) || 16;
  const indent = parseFloat(style.textIndent) || 0;
  const content = dom.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  if (content <= 0) return null;
  const scale = dom.getBoundingClientRect().width / (dom.offsetWidth || 1) || 1;
  dom.classList.add("line-measure");
  try {
    const spacing: number[] = [];
    let from = 0;
    for (const item of breaks) {
      // The space a line ends with counts: pages keep it on the line (white-space: break-spaces).
      const end = item.at;
      const spaces = spacesBetween(node, from, end);
      // Where the line's text starts and ends, laid out unbroken: the edges of the letters at its ends.
      const left = view.coordsAtPos(start + from, 1).left;
      let right = view.coordsAtPos(start + end, -1).right;
      if (item.hyphen) {
        for (const el of Array.from(dom.querySelectorAll(".lf-hyphen"))) {
          const at = view.posAtDOM(el, 0);
          if (Math.abs(at - (start + item.at)) <= 1) right = Math.max(right, el.getBoundingClientRect().right);
        }
      }
      const natural = (right - left) / scale;
      const available = content - (from === 0 ? indent : 0);
      // Just short of full: the next word can't fit, and justification takes up the rest.
      const room = available - natural - 0.3;
      if (!spaces) return null;
      const each = room / spaces;
      // More than TeX would ever squeeze or stretch: the text isn't what was measured in the PDF.
      if (each < -0.25 * fontSize || each > 1.2 * fontSize) return null;
      spacing.push(each);
      from = item.at;
    }
    return spacing;
  } finally {
    dom.classList.remove("line-measure");
  }
}


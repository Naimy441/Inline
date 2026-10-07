import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

/**
 * Justified text the way Google Docs justifies it, for documents laid out as
 * Google lays them out (settings lineModel "font"). Google spreads a line's
 * spare room over its spaces in whole pixels: every space gets the same
 * number, and the first few one more, until the room is used. The page's own
 * justification spreads it evenly instead, so words would sit up to a few
 * points off. These paragraphs are set ragged (document.css `.g-justify`) and
 * each space on a line that isn't the paragraph's last is widened by the
 * pixels Google would give it, measured after layout like the tabs.
 */

type JustifyState = { extras: Map<number, number>; decorations: DecorationSet };

const key = new PluginKey<JustifyState>("justify");

const justified = (node: PMNode) => node.isTextblock && node.attrs.align === "justify" && node.attrs.dir !== "rtl" && !node.type.spec.code;

function decorate(doc: PMNode, extras: Map<number, number>) {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (justified(node)) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "g-justify" }));
    return false;
  });
  for (const [pos, extra] of extras) if (extra > 0 && pos < doc.content.size) decorations.push(Decoration.inline(pos, pos + 1, { class: "g-space", style: `letter-spacing: ${extra}px` }));
  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

export function justifyPlugin(enabled: () => boolean) {
  return new Plugin<JustifyState>({
    key,
    state: {
      init: (_config, state) => ({ extras: new Map(), decorations: enabled() ? decorate(state.doc, new Map()) : DecorationSet.empty }),
      apply(tr, value, _old, state) {
        const measured = tr.getMeta(key) as Map<number, number> | undefined;
        if (!enabled()) return value.decorations === DecorationSet.empty ? value : { extras: new Map(), decorations: DecorationSet.empty };
        if (measured) return { extras: measured, decorations: decorate(state.doc, measured) };
        if (!tr.docChanged && value.decorations !== DecorationSet.empty) return value;
        // Spaces keep their widths until they are measured again.
        const extras = new Map<number, number>();
        for (const [pos, extra] of value.extras) {
          const mapped = tr.mapping.mapResult(pos, 1);
          if (!mapped.deleted) extras.set(mapped.pos, extra);
        }
        return { extras, decorations: decorate(state.doc, extras) };
      },
    },
    props: {
      decorations: (state) => key.getState(state)?.decorations,
    },
    view(view) {
      let frame = 0;
      let settle = 0;
      const schedule = () => {
        if (frame || !enabled()) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          const extras = measure(view);
          if (!extras) return;
          const current = key.getState(view.state)!.extras;
          const same = extras.size === current.size && [...extras].every(([pos, extra]) => current.get(pos) === extra);
          if (same) {
            settle = 0;
            return;
          }
          if (settle > 6) return;
          settle += 1;
          view.dispatch(view.state.tr.setMeta(key, extras).setMeta("addToHistory", false));
        });
      };
      const fonts = typeof document !== "undefined" ? document.fonts : undefined;
      const onFonts = () => {
        settle = 0;
        schedule();
      };
      fonts?.addEventListener?.("loadingdone", onFonts);
      // A new text width (page size, margins) rewraps the lines without any edit.
      let width = 0;
      const resized = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
        const next = (view.dom as HTMLElement).offsetWidth;
        if (next === width) return;
        width = next;
        onFonts();
      }) : null;
      resized?.observe(view.dom);
      schedule();
      return {
        update(updated, previous) {
          if (updated.state.doc !== previous.doc) settle = 0;
          if (updated.state.doc !== previous.doc || key.getState(updated.state) !== key.getState(previous)) schedule();
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

type Word = { left: number; right: number; middle: number; start: number; end: number };

/** The whole pixels each space in a justified paragraph gets, by position; null when the layout can't be read. */
function measure(view: EditorView): Map<number, number> | null {
  const root = view.dom as HTMLElement;
  if (!root.isConnected || !root.offsetWidth) return null;
  // Lines are measured as they fall with plain spaces (document.css drops the widening for an instant,
  // before anything is painted), so the widths never depend on the last measurement.
  root.classList.add("measuring-natural");
  try {
    return measureNatural(view, root);
  } finally {
    root.classList.remove("measuring-natural");
  }
}

function measureNatural(view: EditorView, root: HTMLElement): Map<number, number> {
  const rootRect = root.getBoundingClientRect();
  const scale = rootRect.width / root.offsetWidth || 1;
  const extras = new Map<number, number>();

  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (!justified(node)) return false;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return false;
    const style = getComputedStyle(dom);
    const right = (dom.getBoundingClientRect().right - rootRect.left) / scale - (parseFloat(style.paddingRight) || 0) - (parseFloat(style.borderRightWidth) || 0);

    // Each word's box, and where it is in the document.
    const words: Word[] = [];
    const breaks: number[] = [];
    const tabs: number[] = [];
    node.forEach((child, offset) => {
      if (child.type.name === "hard_break") breaks.push(pos + 1 + offset);
    });
    const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode() as Text | null; text; text = walker.nextNode() as Text | null) {
      if (text.parentElement?.closest(".page-gap")) continue;
      if (text.parentElement?.closest(".doc-tab")) {
        tabs.push(view.posAtDOM(text, 0));
        continue;
      }
      for (const match of text.data.matchAll(/[^ \t]+/g)) {
        const range = document.createRange();
        range.setStart(text, match.index!);
        range.setEnd(text, match.index! + match[0].length);
        const rects = Array.from(range.getClientRects()).filter((rect) => rect.width || rect.height);
        if (rects.length !== 1) continue;
        const rect = rects[0]!;
        let start: number;
        try {
          start = view.posAtDOM(text, match.index!);
        } catch {
          continue;
        }
        words.push({ left: (rect.left - rootRect.left) / scale, right: (rect.right - rootRect.left) / scale, middle: (rect.top + rect.bottom) / 2, start, end: start + match[0].length });
      }
    }
    words.sort((a, b) => a.start - b.start);

    // Lines: words in order, a new line where a word sits lower.
    const lines: Word[][] = [];
    for (const word of words) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(line[line.length - 1]!.middle - word.middle) < 3) line.push(word);
      else lines.push([word]);
    }
    lines.forEach((line, index) => {
      // The last line, a line that ends in a line break, and lines with tabs keep their natural spacing.
      if (index === lines.length - 1) return;
      const first = line[0]!;
      const last = line[line.length - 1]!;
      const next = lines[index + 1]![0]!;
      if (breaks.some((at) => at >= last.end && at < next.start)) return;
      if (tabs.some((at) => at >= first.start && at < next.start)) return;
      const spaces: number[] = [];
      for (let i = 0; i + 1 < line.length; i += 1) {
        for (let at = line[i]!.end; at < line[i + 1]!.start; at += 1) if (node.textBetween(at - pos - 1, at - pos) === " ") spaces.push(at);
      }
      if (!spaces.length) return;
      const room = Math.floor(right - last.right + 0.001);
      if (room <= 0) return;
      const each = Math.floor(room / spaces.length);
      const more = room % spaces.length;
      spaces.forEach((at, i) => {
        const extra = each + (i < more ? 1 : 0);
        if (extra) extras.set(at, extra);
      });
    });
    return false;
  });
  return extras;
}

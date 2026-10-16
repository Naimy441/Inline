import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection, Plugin, TextSelection, type EditorState } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import { schema } from "@/lib/doc/schema";
import { findToc, pageFromStarts, selectionReplacingTocGap, syncedToc } from "@/lib/doc/toc";
import { followLink } from "@/lib/editor/commands";
import { pageKey } from "@/lib/editor/pagination";

/**
 * The contents field on the page. Entries are real blocks, so a long list
 * breaks across pages with the rest of the document. Page numbers and the
 * dotted leaders are drawn here from the layout; they are not text the user
 * edits, and they are not stored.
 */

const entryViews = new Set<TocEntryView>();

/** Where pages 2, 3, … start, from the pagination plugin. */
export function pageStartsIn(state: EditorState): number[] {
  return pageKey.getState(state)?.breaks.map((item) => item.pos) ?? [];
}

function pageOfHeading(state: EditorState, id: string | null): number | null {
  if (!id) return null;
  let pos: number | null = null;
  state.doc.descendants((node, at) => {
    if (pos != null) return false;
    if (node.attrs.id === id) {
      pos = at;
      return false;
    }
    return node.isBlock && !node.isTextblock;
  });
  return pos == null ? null : pageFromStarts(pageStartsIn(state), pos);
}

function entryIndent(state: EditorState, pos: number, level: number): number {
  const parent = state.doc.resolve(pos).parent;
  let min = level;
  parent.forEach((child) => {
    if (child.type.name === "toc_entry" && !child.attrs.placeholder) min = Math.min(min, Number(child.attrs.level) || 1);
  });
  return Math.max(0, level - min);
}

/** Rebuild contents fields whose headings changed. Page numbers are not part of this. */
export function tocSyncPlugin() {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        return handleTocKey(view, event);
      },
    },
    appendTransaction(transactions, _old, state) {
      let tr = state.tr;
      let changed = false;
      if (transactions.some((item) => item.docChanged && !item.getMeta("tocSync"))) {
        const found: Array<{ pos: number; node: PMNode }> = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name === "toc") {
            found.push({ pos, node });
            return false;
          }
          return true;
        });
        for (const item of found.reverse()) {
          const mapped = tr.mapping.mapResult(item.pos, 1);
          if (mapped.deleted) continue;
          const current = tr.doc.nodeAt(mapped.pos);
          if (!current || current.type.name !== "toc") continue;
          const updated = syncedToc(current, tr.doc);
          if (updated === current) continue;
          tr = tr.replaceWith(mapped.pos, mapped.pos + current.nodeSize, updated);
          changed = true;
        }
      }
      const doc = changed ? tr.doc : state.doc;
      const selection = selectionReplacingTocGap(doc, changed ? tr.selection : state.selection);
      if (selection && !selection.eq(changed ? tr.selection : state.selection)) {
        tr = tr.setSelection(selection);
        changed = true;
      }
      return changed ? tr.setMeta("addToHistory", false).setMeta("tocSync", true) : null;
    },
    view() {
      return {
        update() {
          for (const entry of entryViews) entry.refresh();
        },
        destroy() {
          entryViews.clear();
        },
      };
    },
  });
}

function eventElement(event: Event): Element | null {
  const target = event.target;
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function inTitle(event: Event) {
  return Boolean(eventElement(event)?.closest(".doc-toc-title"));
}

/**
 * Backspace or Delete in an empty heading removes the field. A selected
 * field is left to the normal delete commands. Enter leaves the heading
 * for the following text.
 */
function handleTocKey(view: EditorView, event: KeyboardEvent): boolean {
  if (event.key !== "Backspace" && event.key !== "Delete" && event.key !== "Enter") return false;
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
  const { selection } = view.state;
  if (selection instanceof NodeSelection && selection.node.type.name === "toc") return false;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const { $from } = selection;
  if ($from.parent.type.name !== "toc_title" || $from.depth < 1) return false;
  const toc = $from.node($from.depth - 1);
  if (toc.type.name !== "toc") return false;
  const tocPos = $from.before($from.depth - 1);
  if (event.key === "Enter") {
    const after = tocPos + toc.nodeSize;
    const found = TextSelection.findFrom(view.state.doc.resolve(after), 1);
    if (found) {
      view.dispatch(view.state.tr.setSelection(found).scrollIntoView());
      return true;
    }
    const paragraph = schema.nodes.paragraph!.create();
    const tr = view.state.tr.insert(after, paragraph);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView());
    return true;
  }
  const empty = $from.parent.content.size === 0;
  if (!empty) return false;
  if (event.key === "Backspace" && $from.parentOffset !== 0) return false;
  view.dispatch(view.state.tr.delete(tocPos, tocPos + toc.nodeSize).scrollIntoView());
  return true;
}

/** The field on the page. The heading is editable text; an entry click goes to that heading. */
export class TocView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom = document.createElement("nav");
    this.dom.className = "doc-toc";
    this.dom.setAttribute("data-toc", "true");
    this.contentDOM = this.dom;
    this.paint();
    this.dom.addEventListener("mousedown", (event) => this.onMouseDown(event), true);
    // A click on an entry must not also follow the anchor's href in the browser.
    this.dom.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("a.doc-toc-entry")) event.preventDefault();
    });
  }

  update(node: PMNode) {
    if (node.type.name !== "toc") return false;
    this.node = node;
    this.paint();
    return true;
  }

  private paint() {
    this.dom.setAttribute("data-depth", String(this.node.attrs.depth ?? 3));
    if (this.node.attrs.id) this.dom.setAttribute("data-id", String(this.node.attrs.id));
    else this.dom.removeAttribute("data-id");
  }

  private onMouseDown(event: MouseEvent) {
    if (event.button !== 0) return;
    if (inTitle(event)) return;
    const target = event.target instanceof Element ? event.target : null;
    const entry = target?.closest("a.doc-toc-entry");
    if (entry instanceof HTMLAnchorElement) {
      const href = entry.getAttribute("href");
      if (href) {
        event.preventDefault();
        followLink(href)(this.view.state, this.view.dispatch);
        return;
      }
    }
    const pos = this.getPos();
    if (pos == null) return;
    const title = this.view.state.doc.nodeAt(pos)?.firstChild;
    if (!title?.isTextblock) return;
    event.preventDefault();
    // A click on the field, rather than its heading, still leaves a text caret.
    const selection = TextSelection.create(this.view.state.doc, pos + 2);
    this.view.dispatch(this.view.state.tr.setSelection(selection).scrollIntoView());
    this.view.focus();
  }

  stopEvent(event: Event) {
    if (inTitle(event)) return false;
    return event.type === "mousedown" || event.type === "pointerdown" || event.type === "click";
  }

  ignoreMutation(mutation: MutationRecord | { type: string; target: Node }) {
    if (mutation.type === "selection") return false;
    const target = mutation.target;
    const el = target instanceof Element ? target : target.parentElement;
    if (el?.closest(".doc-toc-title")) return false;
    return true;
  }

  destroy() {
    const pos = this.getPos();
    if (pos != null && findToc(this.view.state.doc)?.pos === pos) return;
  }
}

/** One contents line: the heading, a dotted leader, and the page it falls on. */
export class TocEntryView implements NodeView {
  dom: HTMLElement;
  private label: HTMLElement;
  private leader: HTMLElement | null = null;
  private page: HTMLElement | null = null;
  private frame = 0;
  private observer: ResizeObserver | null = null;
  private filledWidth = -1;
  private filling = false;

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    const placeholder = Boolean(node.attrs.placeholder);
    this.dom = document.createElement(placeholder ? "p" : "a");
    this.dom.className = `doc-toc-entry${placeholder ? " is-placeholder" : ""}`;
    this.dom.contentEditable = "false";
    this.label = document.createElement("span");
    this.label.className = "doc-toc-label";
    this.dom.append(this.label);
    if (!placeholder) {
      this.leader = document.createElement("span");
      this.leader.className = "doc-toc-leader";
      this.leader.setAttribute("aria-hidden", "true");
      this.page = document.createElement("span");
      this.page.className = "doc-toc-page";
      this.dom.append(this.leader, this.page);
    }
    entryViews.add(this);
    this.render();
    if (this.leader && typeof ResizeObserver !== "undefined") {
      // The first paint can happen before the line has a width. Fill again once it does.
      this.observer = new ResizeObserver(() => this.fillLeader());
      this.observer.observe(this.dom);
    }
  }

  update(node: PMNode) {
    if (node.type.name !== "toc_entry" || Boolean(node.attrs.placeholder) !== Boolean(this.node.attrs.placeholder)) return false;
    this.node = node;
    this.render();
    return true;
  }

  refresh() {
    this.render();
  }

  private render() {
    const level = Number(this.node.attrs.level) || 1;
    const text = String(this.node.attrs.text ?? "");
    const placeholder = Boolean(this.node.attrs.placeholder);
    const pos = this.getPos();
    const indent = pos == null ? 0 : entryIndent(this.view.state, pos, level);
    this.dom.setAttribute("data-level", String(level));
    this.dom.style.paddingLeft = indent ? `${indent * 18}px` : "";
    this.label.textContent = text;
    if (placeholder || !(this.dom instanceof HTMLAnchorElement)) {
      this.dom.removeAttribute("href");
      return;
    }
    const href = (this.node.attrs.href as string | null) ?? "";
    if (href) this.dom.setAttribute("href", href);
    else this.dom.removeAttribute("href");
    const page = href.startsWith("#") ? pageOfHeading(this.view.state, href.slice(1)) : null;
    const pageText = page == null ? "" : String(page);
    if (this.page && this.page.textContent !== pageText) this.page.textContent = pageText;
    this.dom.setAttribute("aria-label", pageText ? `${text}, page ${pageText}` : text);
    this.scheduleLeader();
  }

  /** As many period leaders as fit between the heading and the page number. */
  private scheduleLeader() {
    if (this.frame || !this.leader) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.fillLeader();
    });
  }

  private fillLeader() {
    const leader = this.leader;
    const page = this.page;
    if (this.filling || !leader || !page || !this.dom.isConnected) return;
    this.filling = true;
    try {
      this.measureLeader(leader);
    } finally {
      this.filling = false;
    }
  }

  private measureLeader(leader: HTMLElement) {
    const roomWidth = leader.clientWidth;
    // Not laid out yet. Keep the CSS fallback and try again when the line has a width.
    if (roomWidth < 8) return;
    if (roomWidth === this.filledWidth && (leader.textContent?.length ?? 0) > 2) return;
    const widthOf = (count: number) => {
      leader.textContent = ".".repeat(count);
      if (!count || !leader.firstChild) return 0;
      const range = document.createRange();
      range.selectNodeContents(leader);
      return range.getBoundingClientRect().width;
    };
    // The element's own box is the flex track, not the width of one period.
    const one = widthOf(1) || 4;
    let low = 0;
    let high = Math.max(1, Math.ceil(roomWidth / one));
    let best = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (widthOf(mid) <= roomWidth + 0.5) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    leader.textContent = ".".repeat(best);
    this.filledWidth = best > 0 ? roomWidth : -1;
  }

  ignoreMutation() {
    return true;
  }

  destroy() {
    entryViews.delete(this);
    this.observer?.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
  }
}

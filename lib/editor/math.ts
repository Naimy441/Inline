import katex from "katex";
import { DOMSerializer, type Node as PMNode } from "prosemirror-model";
import { InputRule } from "prosemirror-inputrules";
import { Plugin, PluginKey, TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "prosemirror-view";
import { MATH_LANGUAGE, schema } from "@/lib/doc/schema";

/**
 * Equations. An inline equation is text with the `math` mark holding its
 * LaTeX; a displayed one is a code block in the "math" language. Both show
 * typeset with KaTeX, and turn back into their LaTeX source, with a live
 * preview, while the cursor is in them: click an equation or arrow into it to
 * edit, and move out (or press Enter or Escape) to see it typeset again.
 */

type MathRange = { from: number; to: number; tex: string };
type MathState = { editing: number | null; decorations: DecorationSet; any: boolean };
type MathMeta = { edit: number | null };

export const mathKey = new PluginKey<MathState>("math");

const rangesCache = new WeakMap<PMNode, MathRange[]>();

/** Every inline equation in the document: runs of text with the math mark. */
export function mathRanges(doc: PMNode): MathRange[] {
  const cached = rangesCache.get(doc);
  if (cached) return cached;
  const ranges: MathRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    let current: MathRange | null = null;
    node.forEach((child, offset) => {
      const from = pos + 1 + offset;
      if (child.isText && child.marks.some((mark) => mark.type.name === "math")) {
        if (current && current.to === from) {
          current.to += child.nodeSize;
          current.tex += child.text;
        } else {
          current = { from, to: from + child.nodeSize, tex: child.text ?? "" };
          ranges.push(current);
        }
      } else current = null;
    });
    return false;
  });
  rangesCache.set(doc, ranges);
  return ranges;
}

function rangeAt(doc: PMNode, pos: number): MathRange | undefined {
  return mathRanges(doc).find((range) => range.from <= pos && pos <= range.to);
}

/** The displayed equation the selection is in, as [start, end] of the code block node. */
function blockAt(state: EditorState): { pos: number; node: PMNode } | null {
  const { $from, $to } = state.selection;
  if (!$from.sameParent($to)) return null;
  const parent = $from.parent;
  if (parent.type !== schema.nodes.code_block || parent.attrs.language !== MATH_LANGUAGE) return null;
  return { pos: $from.before(), node: parent };
}

function render(tex: string, element: HTMLElement, displayMode: boolean) {
  element.classList.toggle("is-empty", !tex.trim());
  if (!tex.trim()) {
    element.textContent = displayMode ? "Empty equation" : "?";
    return;
  }
  katex.render(tex, element, { displayMode, throwOnError: false, output: "htmlAndMathml" });
}

function editingFor(prev: number | null, tr: Transaction, state: EditorState): number | null {
  const meta = tr.getMeta(mathKey) as MathMeta | undefined;
  if (meta) return meta.edit;
  const mapped = prev === null ? null : tr.mapping.map(prev, 1);
  const { from, to, empty, head } = state.selection;
  const range = rangeAt(state.doc, head);
  if (!range || from < range.from || to > range.to) return null;
  // Strictly inside: editing. On its edge: only if it was already being edited (arrowing out reveals nothing new).
  if ((head > range.from && head < range.to) || !empty) return range.from;
  return mapped === range.from ? range.from : null;
}

function buildDecorations(state: EditorState, editing: number | null): DecorationSet {
  const decorations: Decoration[] = [];
  const { from: selFrom, to: selTo } = state.selection;
  for (const range of mathRanges(state.doc)) {
    if (range.from === editing) {
      decorations.push(Decoration.inline(range.from, range.to, { class: "math-src is-editing", spellcheck: "false" }));
      decorations.push(
        Decoration.widget(
          range.to,
          () => {
            const anchor = document.createElement("span");
            anchor.className = "math-preview";
            anchor.contentEditable = "false";
            const pop = document.createElement("span");
            pop.className = "math-pop";
            render(range.tex, pop, false);
            anchor.append(pop);
            return anchor;
          },
          { side: 1, key: `p${range.tex}`, ignoreSelection: true, stopEvent: () => true },
        ),
      );
      continue;
    }
    const selected = selFrom <= range.from && selTo >= range.to && selFrom !== selTo;
    decorations.push(Decoration.inline(range.from, range.to, { class: "math-src is-hidden" }));
    decorations.push(
      Decoration.widget(
        range.from,
        (view, getPos) => {
          const element = document.createElement("span");
          element.className = `math-render${selected ? " is-selected" : ""}`;
          element.contentEditable = "false";
          element.title = "Edit equation";
          render(range.tex, element, false);
          element.addEventListener("mousedown", (event) => {
            event.preventDefault();
            const pos = getPos();
            if (pos === undefined) return;
            const current = rangeAt(view.state.doc, pos);
            if (!current) return;
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, current.to)).setMeta(mathKey, { edit: current.from } satisfies MathMeta));
            view.focus();
          });
          return element;
        },
        { side: -1, key: `m${range.tex}${selected ? "|s" : ""}`, ignoreSelection: true, stopEvent: () => true },
      ),
    );
  }
  // A displayed equation shows its LaTeX while the cursor is in it.
  const block = blockAt(state);
  if (block) decorations.push(Decoration.node(block.pos, block.pos + block.node.nodeSize, { class: "is-editing" }));
  return DecorationSet.create(state.doc, decorations);
}

function hasMath(doc: PMNode) {
  if (mathRanges(doc).length) return true;
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.type === schema.nodes.code_block && node.attrs.language === MATH_LANGUAGE) found = true;
    return !node.isTextblock;
  });
  return found;
}

/** Leave the equation being edited: the cursor goes after it and it shows typeset again. */
function closeEquation(view: EditorView, editing: number): boolean {
  const range = rangeAt(view.state.doc, editing);
  if (!range) return false;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.to)).setStoredMarks([]).setMeta(mathKey, { edit: null } satisfies MathMeta));
  return true;
}

function handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const state = view.state;
  const editing = mathKey.getState(state)?.editing ?? null;
  const { empty, head } = state.selection;
  if (editing !== null && (event.key === "Enter" || event.key === "Escape") && !event.shiftKey) return closeEquation(view, editing);
  if (!empty || event.shiftKey) {
    return false;
  }
  const range = rangeAt(state.doc, head);
  // Arrowing into a typeset equation opens its source with the cursor on that edge.
  if (range && range.from !== editing) {
    const into = (event.key === "ArrowLeft" && head === range.to) || (event.key === "ArrowRight" && head === range.from);
    if (into) {
      view.dispatch(state.tr.setMeta(mathKey, { edit: range.from } satisfies MathMeta));
      return true;
    }
    // Deleting into one selects it whole first, so it isn't erased a character at a time unseen.
    const deleting = (event.key === "Backspace" && head === range.to) || (event.key === "Delete" && head === range.from);
    if (deleting) {
      view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, range.from, range.to)));
      return true;
    }
  }
  // Moving from the next or previous block into a displayed equation, whose source is hidden.
  const vertical = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
  if (vertical && view.endOfTextblock(vertical > 0 ? (event.key === "ArrowDown" ? "down" : "right") : event.key === "ArrowUp" ? "up" : "left")) {
    const $head = state.selection.$head;
    if ($head.depth < 1) return false;
    const index = $head.index($head.depth - 1) + vertical;
    const container = $head.node($head.depth - 1);
    if (index < 0 || index >= container.childCount) return false;
    const sibling = container.child(index);
    if (sibling.type !== schema.nodes.code_block || sibling.attrs.language !== MATH_LANGUAGE) return false;
    const siblingPos = vertical > 0 ? $head.after() : $head.before() - sibling.nodeSize;
    const target = vertical > 0 ? siblingPos + 1 : siblingPos + sibling.nodeSize - 1;
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, target)).scrollIntoView());
    return true;
  }
  return false;
}

export function mathPlugin() {
  return new Plugin<MathState>({
    key: mathKey,
    state: {
      init: (_config, state) => {
        const any = hasMath(state.doc);
        return { editing: null, any, decorations: any ? buildDecorations(state, null) : DecorationSet.empty };
      },
      apply(tr, prev, _old, state) {
        if (!tr.docChanged && !tr.selectionSet && !tr.getMeta(mathKey)) return prev;
        // Documents without equations skip the work.
        const any = tr.docChanged ? hasMath(state.doc) : prev.any;
        if (!any) return prev.any || prev.editing !== null ? { editing: null, any, decorations: DecorationSet.empty } : prev;
        const editing = editingFor(prev.editing, tr, state);
        return { editing, any, decorations: buildDecorations(state, editing) };
      },
    },
    props: {
      decorations: (state) => mathKey.getState(state)?.decorations,
      handleKeyDown,
      // Typing at the end of the equation being edited adds to its LaTeX (the mark doesn't extend on its own).
      handleTextInput(view, from, to, text) {
        const editing = mathKey.getState(view.state)?.editing ?? null;
        if (editing === null) return false;
        const range = rangeAt(view.state.doc, editing);
        if (!range || from < range.from || to > range.to || (from > range.from && to < range.to)) return false;
        view.dispatch(view.state.tr.replaceWith(from, to, schema.text(text, [schema.mark("math")])));
        return true;
      },
    },
  });
}

/** Whether a position is inside an equation's source, where typing substitutions shouldn't apply. */
export function inMath(state: EditorState, pos: number) {
  const $pos = state.doc.resolve(pos);
  return $pos.marks().some((mark) => mark.type.name === "math") || ($pos.parent.type === schema.nodes.code_block && $pos.parent.attrs.language === MATH_LANGUAGE);
}

/**
 * Typing `$x^2$` turns it into an equation as the closing $ is typed (not for
 * prices: the LaTeX can't start or end with a space). `$$` and a space on an
 * empty line starts a displayed equation.
 */
export const mathInputRules = [
  new InputRule(/(^|[^$\\\w])\$([^\s$](?:[^$]*[^\s$\\])?)\$$/, (state, match, start, end) => {
    const texStart = start + match[1]!.length;
    const $start = state.doc.resolve(texStart);
    if ($start.parent.type.spec.code || $start.marks().some((mark) => mark.type.spec.code)) return null;
    const tex = match[2]!;
    const tr = state.tr.replaceWith(texStart, end, schema.text(tex, [schema.mark("math")]));
    return tr
      .setSelection(TextSelection.create(tr.doc, texStart + tex.length))
      .setStoredMarks([])
      .setMeta(mathKey, { edit: null } satisfies MathMeta);
  }),
  // Only on an empty line: `$$ ` before a sentence shouldn't turn the whole sentence into LaTeX.
  new InputRule(/^\$\$\s$/, (state, _match, start, end) => {
    const $start = state.doc.resolve(start);
    if ($start.parent.content.size !== end - start || !$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), schema.nodes.code_block!)) return null;
    return state.tr.delete(start, end).setBlockType(start, start, schema.nodes.code_block!, { language: MATH_LANGUAGE });
  }),
];

/** Insert an equation, or turn the selected text into one, ready to type LaTeX into. */
export function insertEquation(display: boolean): Command {
  return (state, dispatch) => {
    const { from, to, empty, $from } = state.selection;
    if (!$from.parent.inlineContent || $from.parent.type.spec.code) return false;
    const selected = empty || !$from.sameParent(state.selection.$to) ? "" : state.doc.textBetween(from, to);
    const tex = selected.trim() || "x";
    if (!dispatch) return true;
    let tr = state.tr;
    if (display) {
      const block = schema.nodes.code_block!.create({ language: MATH_LANGUAGE }, schema.text(tex));
      // A displayed equation replaces an empty paragraph, or goes after the current one.
      if (!$from.parent.content.size || (selected && from === $from.start() && to === $from.end())) {
        tr = tr.replaceWith($from.before(), $from.after(), block);
        const start = $from.before() + 1;
        tr.setSelection(TextSelection.create(tr.doc, start, start + tex.length));
      } else {
        if (selected) tr.delete(from, to);
        const at = tr.mapping.map($from.after());
        tr.insert(at, block);
        tr.setSelection(TextSelection.create(tr.doc, at + 1, at + 1 + tex.length));
      }
    } else {
      tr = tr.replaceWith(from, to, schema.text(tex, [schema.mark("math")]));
      tr.setSelection(TextSelection.create(tr.doc, from, from + tex.length)).setMeta(mathKey, { edit: from } satisfies MathMeta);
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * Code blocks: a displayed equation shows typeset above its LaTeX (which is
 * only shown while editing); any other code block renders as usual.
 */
export function codeBlockView(node: PMNode, view: EditorView, getPos: () => number | undefined): NodeView {
  if (node.attrs.language === MATH_LANGUAGE) return new MathBlockView(node, view, getPos);
  const { dom, contentDOM } = DOMSerializer.renderSpec(document, node.type.spec.toDOM!(node));
  return {
    dom: dom as HTMLElement,
    contentDOM: contentDOM as HTMLElement,
    update: (next) => next.type === node.type && next.attrs.language === node.attrs.language && next.attrs.id === node.attrs.id,
  };
}

class MathBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private preview: HTMLElement;
  private tex: string | null = null;

  constructor(
    private node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "math-block";
    if (node.attrs.id) this.dom.dataset.id = node.attrs.id;
    this.preview = document.createElement("div");
    this.preview.className = "math-render math-display";
    this.preview.contentEditable = "false";
    this.preview.title = "Edit equation";
    const pre = document.createElement("pre");
    pre.dataset.language = MATH_LANGUAGE;
    pre.spellcheck = false;
    this.contentDOM = document.createElement("code");
    pre.append(this.contentDOM);
    this.dom.append(this.preview, pre);
    this.preview.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const pos = getPos();
      if (pos === undefined) return;
      const end = pos + this.node.nodeSize - 1;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
      view.focus();
    });
    this.render();
  }

  private render() {
    const tex = this.node.textContent;
    if (tex === this.tex) return;
    this.tex = tex;
    render(tex, this.preview, true);
  }

  update(node: PMNode) {
    if (node.type !== this.node.type || node.attrs.language !== MATH_LANGUAGE) return false;
    this.node = node;
    this.render();
    return true;
  }

  stopEvent(event: Event) {
    return this.preview.contains(event.target as Node);
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }) {
    return !this.contentDOM.contains(mutation.target) && mutation.target !== this.contentDOM;
  }
}

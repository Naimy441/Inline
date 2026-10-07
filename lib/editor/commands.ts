import { lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import type { Attrs, MarkType, Node as PMNode, NodeType } from "prosemirror-model";
import { liftListItem, sinkListItem, wrapInList } from "prosemirror-schema-list";
import { NodeSelection, TextSelection, type Command, type EditorState } from "prosemirror-state";
import { isInTable } from "prosemirror-tables";
import { MAX_INDENT, safeHref, schema, type Align } from "@/lib/doc/schema";

/** Editing commands shared by the toolbar, menus, keymap and command palette. */

const marks = schema.marks;
const nodes = schema.nodes;

export function markActive(state: EditorState, type: MarkType) {
  const { from, $from, to, empty } = state.selection;
  if (empty) return Boolean(type.isInSet(state.storedMarks || $from.marks()));
  return state.doc.rangeHasMark(from, to, type);
}

export function markAttr(state: EditorState, type: MarkType, attr: string): string | null {
  const { $from, from, to, empty } = state.selection;
  if (empty) return (type.isInSet(state.storedMarks || $from.marks())?.attrs[attr] as string) ?? null;
  let value: string | null | undefined;
  let mixed = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    const mark = type.isInSet(node.marks);
    const next = (mark?.attrs[attr] as string) ?? null;
    if (value === undefined) value = next;
    else if (value !== next) mixed = true;
    return false;
  });
  return mixed ? null : (value ?? null);
}

export const toggle = (name: keyof typeof marks) => toggleMark(marks[name]!);

/** Apply (or with null, remove) an attribute mark such as text color or font size over the selection. */
export function setMark(type: MarkType, attrs: Attrs | null): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (!dispatch) return true;
    const tr = state.tr;
    if (empty) {
      const stored = (state.storedMarks || state.selection.$from.marks()).filter((mark) => mark.type !== type);
      tr.setStoredMarks(attrs ? [...stored, type.create(attrs)] : stored);
    } else {
      tr.removeMark(from, to, type);
      if (attrs) tr.addMark(from, to, type.create(attrs));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export const clearFormatting: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection;
  if (empty) return false;
  if (dispatch) {
    const tr = state.tr;
    for (const type of Object.values(marks)) {
      if (type.name === "comment" || type.name === "locked" || type.name === "link") continue;
      tr.removeMark(from, to, type);
    }
    dispatch(tr);
  }
  return true;
};

export type BlockKind = "paragraph" | "title" | "subtitle" | "h1" | "h2" | "h3" | "h4" | "code";

export function blockKind(state: EditorState): BlockKind | null {
  const { $from, $to } = state.selection;
  const parent = $from.parent;
  if (!$from.sameParent($to) && !(state.selection instanceof TextSelection)) return null;
  switch (parent.type.name) {
    case "paragraph":
      return "paragraph";
    case "title":
      return "title";
    case "subtitle":
      return "subtitle";
    case "heading":
      return `h${Math.min(4, parent.attrs.level as number)}` as BlockKind;
    case "code_block":
      return "code";
    default:
      return null;
  }
}

/** Change the textblocks in the selection, keeping alignment and indentation. */
export function setBlock(kind: BlockKind): Command {
  const target: [NodeType, Attrs | null] =
    kind === "paragraph"
      ? [nodes.paragraph!, null]
      : kind === "title"
        ? [nodes.title!, null]
        : kind === "subtitle"
          ? [nodes.subtitle!, null]
          : kind === "code"
            ? [nodes.code_block!, null]
            : [nodes.heading!, { level: Number(kind.slice(1)) }];
  return (state, dispatch) => {
    const { from, to } = state.selection;
    if (!dispatch) return setBlockType(target[0], target[1] ?? undefined)(state);
    const tr = state.tr;
    let applied = false;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return true;
      if (!target[0].validContent(node.content) && target[0] !== nodes.code_block) return false;
      const keep = "align" in node.attrs && "align" in (target[0].spec.attrs ?? {}) ? { id: node.attrs.id, align: node.attrs.align, indent: node.attrs.indent } : { id: node.attrs.id };
      const mapped = tr.mapping.map(pos);
      try {
        if (target[0] === nodes.code_block) tr.setBlockType(mapped, mapped + node.nodeSize, target[0], { id: node.attrs.id });
        else tr.setNodeMarkup(mapped, target[0], { ...keep, ...(target[1] ?? {}) });
        applied = true;
      } catch {
        // The block can't hold this type here (e.g. inside a table header); skip it.
      }
      return false;
    });
    if (applied) dispatch(tr.scrollIntoView());
    return applied;
  };
}

function textblocksInSelection(state: EditorState) {
  const out: Array<{ node: PMNode; pos: number }> = [];
  const { from, to } = state.selection;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) {
      out.push({ node, pos });
      return false;
    }
    return true;
  });
  return out;
}

function updateBlocks(update: (node: PMNode) => Attrs | null): Command {
  return (state, dispatch) => {
    const blocks = textblocksInSelection(state).filter(({ node }) => "align" in node.attrs);
    if (!blocks.length) return false;
    if (dispatch) {
      const tr = state.tr;
      for (const { node, pos } of blocks) {
        const attrs = update(node);
        if (attrs) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
      }
      dispatch(tr);
    }
    return true;
  };
}

export const setAlign = (align: Align) => updateBlocks(() => ({ align }));

export function currentAlign(state: EditorState): Align {
  const parent = state.selection.$from.parent;
  return ((parent.attrs.align as Align) ?? "left") || "left";
}

export const setLineHeight = (lineHeight: string | null) => updateBlocks(() => ({ lineHeight }));
export const setSpacing = (spaceBefore: number | null, spaceAfter: number | null) => updateBlocks(() => ({ spaceBefore, spaceAfter }));

export function currentLineHeight(state: EditorState): string | null {
  return (state.selection.$from.parent.attrs.lineHeight as string | null) ?? null;
}

function inList(state: EditorState) {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) if ($from.node(depth).type === nodes.list_item) return true;
  return false;
}

export const indent: Command = (state, dispatch) => {
  if (inList(state)) return sinkListItem(nodes.list_item!)(state, dispatch);
  return updateBlocks((node) => ({ indent: Math.min(MAX_INDENT, (node.attrs.indent as number) + 1) }))(state, dispatch);
};

/**
 * Tab types a tab, as in Google Docs and Word, except at the start of a list
 * item that can nest (which nests it) and over several blocks (which indents them).
 */
export const insertTab: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return false;
  if (inList(state) && $from.parentOffset === 0 && sinkListItem(nodes.list_item!)(state)) return false;
  if (dispatch) dispatch(state.tr.insertText("\t").scrollIntoView());
  return true;
};

export const outdent: Command = (state, dispatch) => {
  if (inList(state)) return liftListItem(nodes.list_item!)(state, dispatch);
  return updateBlocks((node) => ((node.attrs.indent as number) > 0 ? { indent: (node.attrs.indent as number) - 1 } : null))(state, dispatch);
};

export type ListKind = "bullet" | "ordered" | "task";

export function listKind(state: EditorState): ListKind | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type === nodes.bullet_list || node.type === nodes.ordered_list) {
      const item = $from.node(depth + 1);
      if (item?.attrs.checked != null) return "task";
      return node.type === nodes.bullet_list ? "bullet" : "ordered";
    }
  }
  return null;
}

/** Toggle a list: wrap, unwrap, or convert between list kinds. */
export function toggleList(kind: ListKind): Command {
  return (state, dispatch) => {
    const current = listKind(state);
    const listType = kind === "ordered" ? nodes.ordered_list! : nodes.bullet_list!;
    if (current === kind) return liftListItem(nodes.list_item!)(state, dispatch);
    if (current) {
      // Convert the enclosing list in place.
      const { $from } = state.selection;
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        const node = $from.node(depth);
        if (node.type !== nodes.bullet_list && node.type !== nodes.ordered_list) continue;
        if (dispatch) {
          const pos = $from.before(depth);
          const tr = state.tr.setNodeMarkup(pos, listType, { id: node.attrs.id });
          node.forEach((item, offset) => {
            tr.setNodeMarkup(pos + 1 + offset, undefined, { ...item.attrs, checked: kind === "task" ? Boolean(item.attrs.checked) : null });
          });
          dispatch(tr);
        }
        return true;
      }
      return false;
    }
    return wrapInList(listType)(state, (tr) => {
      if (kind === "task") {
        const { from, to } = tr.selection;
        tr.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type === nodes.list_item && node.attrs.checked == null) tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false });
          return true;
        });
      }
      dispatch?.(tr);
    });
  };
}

/** Toggle the checkbox of the task item containing `pos`. */
export function toggleTask(pos: number): Command {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(pos);
    if (!node || node.type !== nodes.list_item || node.attrs.checked == null) return false;
    dispatch?.(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }));
    return true;
  };
}

export const toggleBlockquote: Command = (state, dispatch) => {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type === nodes.blockquote) return lift(state, dispatch);
  }
  return wrapIn(nodes.blockquote!)(state, dispatch);
};

function insertBlock(node: PMNode, enter = false): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const { $from } = state.selection;
    const tr = state.tr;
    // Insert after the current top-level block, then put the cursor after it.
    const depth = Math.min(1, $from.depth);
    const after = depth ? $from.after(depth) : state.selection.to;
    tr.insert(after, node);
    let cursor = after + node.nodeSize;
    if (cursor >= tr.doc.content.size || !tr.doc.resolve(cursor).nodeAfter?.isTextblock) {
      tr.insert(cursor, nodes.paragraph!.create());
    }
    cursor = enter ? after + 1 : Math.min(cursor + 1, tr.doc.content.size);
    tr.setSelection(TextSelection.near(tr.doc.resolve(cursor)));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export const insertHorizontalRule = insertBlock(nodes.horizontal_rule!.create());
export const insertPageBreak = insertBlock(nodes.page_break!.create());

export function insertImage(src: string, alt = "", width: string | null = null): Command {
  return insertBlock(nodes.image!.create({ src, alt, width, align: "center" }));
}

export function insertTable(rows: number, cols: number): Command {
  const cell = (header: boolean) => (header ? nodes.table_header! : nodes.table_cell!).createAndFill()!;
  const table = nodes.table!.create(
    null,
    Array.from({ length: rows }, (_row, r) => nodes.table_row!.create(null, Array.from({ length: cols }, () => cell(r === 0)))),
  );
  return (state, dispatch) => {
    if (isInTable(state)) return false;
    // Start typing in the first cell, like Docs and Word.
    return insertBlock(table, true)(state, dispatch);
  };
}

export function setImageAttrs(attrs: Partial<{ width: string | null; align: Align; alt: string }>): Command {
  return (state, dispatch) => {
    const selection = state.selection;
    if (!(selection instanceof NodeSelection) || selection.node.type !== nodes.image) return false;
    dispatch?.(state.tr.setNodeMarkup(selection.from, undefined, { ...selection.node.attrs, ...attrs }));
    return true;
  };
}

/** The link around the cursor, if any. */
export function linkAt(state: EditorState): { from: number; to: number; href: string } | null {
  const { $from, from, to } = state.selection;
  const type = marks.link!;
  const mark = type.isInSet($from.marks()) ?? (from !== to ? null : type.isInSet($from.nodeAfter?.marks ?? []));
  if (!mark) {
    if (from !== to && state.doc.rangeHasMark(from, to, type)) {
      let href = "";
      state.doc.nodesBetween(from, to, (node) => {
        const found = type.isInSet(node.marks);
        if (found && !href) href = found.attrs.href as string;
      });
      return { from, to, href };
    }
    return null;
  }
  // Expand to the whole link.
  const parent = $from.parent;
  const offset = $from.parentOffset;
  let start = offset;
  let end = offset;
  const start0 = $from.start();
  const hasLink = (index: number) => {
    const child = parent.childAfter(index).node;
    return child ? mark.isInSet(child.marks) : false;
  };
  while (start > 0 && parent.childBefore(start).node && mark.isInSet(parent.childBefore(start).node!.marks)) start -= parent.childBefore(start).node!.nodeSize;
  while (end < parent.content.size && hasLink(end)) end += parent.childAfter(end).node!.nodeSize;
  return { from: start0 + Math.max(0, start), to: start0 + end, href: mark.attrs.href as string };
}

export function setLink(rawHref: string | null, text?: string): Command {
  const href = rawHref === null ? null : safeHref(/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(rawHref.trim()) ? `https://${rawHref.trim()}` : rawHref);
  return (state, dispatch) => {
    if (rawHref !== null && !href) return false;
    if (!dispatch) return true;
    const type = marks.link!;
    const existing = linkAt(state);
    let { from, to } = existing ?? state.selection;
    const tr = state.tr;
    if (text && from === to) {
      tr.insertText(text, from);
      to = from + text.length;
    }
    if (from === to) return false;
    tr.removeMark(from, to, type);
    if (href) tr.addMark(from, to, type.create({ href: normalizeHref(href) }));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export function normalizeHref(href: string) {
  const trimmed = href.trim();
  if (/^(https?:|mailto:|tel:|#|\/)/i.test(trimmed)) return trimmed;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return `mailto:${trimmed}`;
  return `https://${trimmed}`;
}

export function selectedText(state: EditorState) {
  const { from, to } = state.selection;
  return state.doc.textBetween(from, to, "\n");
}

export type CaseKind = "lower" | "upper" | "title" | "sentence";

const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "the", "to", "up", "via"]);

function recase(text: string, kind: CaseKind, atStart: boolean) {
  if (kind === "lower") return text.toLowerCase();
  if (kind === "upper") return text.toUpperCase();
  if (kind === "sentence") {
    let capitalize = atStart;
    return text.toLowerCase().replace(/[\p{L}\p{N}]|[.!?]/gu, (char) => {
      if (/[.!?]/.test(char)) {
        capitalize = true;
        return char;
      }
      if (capitalize) {
        capitalize = false;
        return char.toUpperCase();
      }
      return char;
    });
  }
  let first = atStart;
  return text.toLowerCase().replace(/[\p{L}\p{N}][\p{L}\p{N}'’]*/gu, (word) => {
    const keepSmall = !first && SMALL_WORDS.has(word);
    first = false;
    return keepSmall ? word : word[0]!.toUpperCase() + word.slice(1);
  });
}

/** Change the capitalization of the selected text, keeping its formatting. */
export function changeCase(kind: CaseKind): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (empty) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    const edits: Array<{ from: number; to: number; text: string; node: PMNode }> = [];
    let previousBlock = -1;
    state.doc.nodesBetween(from, to, (node, pos, parent) => {
      if (!node.isText || !parent) return true;
      const start = Math.max(from, pos);
      const end = Math.min(to, pos + node.nodeSize);
      const blockStart = state.doc.resolve(start).start();
      const atStart = blockStart !== previousBlock && state.doc.textBetween(blockStart, start).trim() === "";
      previousBlock = blockStart;
      const original = node.text!.slice(start - pos, end - pos);
      const text = recase(original, kind, atStart || kind === "title");
      if (text !== original) edits.push({ from: start, to: end, text, node });
      return false;
    });
    // Apply from the end so earlier positions stay valid even if a length changes (ß → SS).
    for (const edit of edits.reverse()) tr.replaceWith(edit.from, edit.to, schema.text(edit.text, edit.node.marks));
    if (!tr.docChanged) return false;
    tr.setSelection(TextSelection.create(tr.doc, from, tr.mapping.map(to)));
    dispatch(tr);
    return true;
  };
}

/** Insert text at the cursor (special characters, dates). */
export function insertText(text: string): Command {
  return (state, dispatch) => {
    dispatch?.(state.tr.insertText(text).scrollIntoView());
    return true;
  };
}

/**
 * Insert a table of contents: a list of the document's headings, each linking
 * to its heading by block id (#id), indented by level.
 */
export const insertTableOfContents: Command = (state, dispatch) => {
  const headings: Array<{ level: number; text: string; id: string | null }> = [];
  state.doc.forEach((node) => {
    if (node.type === nodes.heading && node.textContent.trim() && (node.attrs.level as number) <= 3) {
      headings.push({ level: node.attrs.level as number, text: node.textContent.trim(), id: (node.attrs.id as string | null) ?? null });
    }
  });
  if (!headings.length) return false;
  if (!dispatch) return true;
  const top = Math.min(...headings.map((item) => item.level));
  const paragraphs = headings.map((item) =>
    nodes.paragraph!.create(
      { indent: Math.min(MAX_INDENT, item.level - top) },
      schema.text(item.text, item.id ? [marks.link!.create({ href: `#${item.id}` })] : []),
    ),
  );
  const heading = nodes.paragraph!.create(null, schema.text("Contents", [marks.bold!.create()]));
  const { $from } = state.selection;
  const depth = Math.min(1, $from.depth);
  const at = depth ? $from.before(depth) : state.selection.from;
  const tr = state.tr.insert(at, [heading, ...paragraphs]);
  dispatch(tr.scrollIntoView());
  return true;
};

/** Position of the top-level block with this id, if it still exists. */
export function blockPosById(doc: PMNode, id: string): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found != null) return false;
    if (node.attrs.id === id) {
      found = pos;
      return false;
    }
    return node.isBlock && !node.isTextblock;
  });
  return found;
}

/** Follow a link: in-document anchors (#block-id) move the cursor there, others open in a new tab. */
export function followLink(href: string): Command {
  return (state, dispatch) => {
    if (href.startsWith("#")) {
      const pos = blockPosById(state.doc, href.slice(1));
      if (pos == null) return false;
      dispatch?.(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos + 1))).scrollIntoView());
      return true;
    }
    if (dispatch) window.open(href, "_blank", "noopener,noreferrer");
    return true;
  };
}

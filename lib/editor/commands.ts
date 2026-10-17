import { chainCommands, lift, setBlockType, splitBlock, toggleMark, wrapIn } from "prosemirror-commands";
import { type Attrs, type MarkType, type Node as PMNode, type NodeType } from "prosemirror-model";
import { liftListItem, sinkListItem, wrapInList } from "prosemirror-schema-list";
import { NodeSelection, TextSelection, type Command, type EditorState } from "prosemirror-state";
import { canSplit } from "prosemirror-transform";
import { isInTable } from "prosemirror-tables";
import { pictureCrop, pictureRotate, pictureWidth, pictureWrap, type PictureCrop, type PictureWrap } from "@/lib/doc/picture";
import { fileLinkHref, MAX_INDENT, safeHref, schema, type Align } from "@/lib/doc/schema";
import { createToc, findToc, tocTitleSelection } from "@/lib/doc/toc";
import { findStyle, nodeStyleId, resolveStyle, storedStyleId, structuralRole, type ParagraphStyle, type StyleRole } from "@/lib/doc/styles";

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

/** The style of every selected text block, or null when they disagree. */
export function currentStyleId(state: EditorState): string | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type === nodes.blockquote) return nodeStyleId($from.node(depth));
  }
  const blocks = textblocksInSelection(state);
  if (!blocks.length) return $from.parent.isTextblock ? nodeStyleId($from.parent) : null;
  const ids = new Set(blocks.map(({ node }) => nodeStyleId(node)));
  return ids.size === 1 ? [...ids][0]! : null;
}

function typeForRole(role: StyleRole) {
  switch (role) {
    case "title":
      return nodes.title!;
    case "subtitle":
      return nodes.subtitle!;
    case "heading":
      return nodes.heading!;
    case "code":
      return nodes.code_block!;
    default:
      return nodes.paragraph!;
  }
}

/** Direct formatting stays; only the style (and the block type it implies) changes. */
function attrsForStyle(node: PMNode, type: NodeType, styleId: string, role: { role: StyleRole; level: number }) {
  const spec = type.spec.attrs ?? {};
  const attrs: Record<string, unknown> = {};
  for (const key of Object.keys(spec)) {
    if (key === "style" || key === "level") continue;
    if (key in node.attrs) attrs[key] = node.attrs[key];
  }
  attrs.style = storedStyleId(styleId, role);
  if (role.role === "heading") attrs.level = role.level;
  return attrs;
}

function applyStyleToBlock(tr: import("prosemirror-state").Transaction, pos: number, node: PMNode, styleId: string, sheet: readonly ParagraphStyle[], placed = false) {
  const role = structuralRole(sheet, styleId);
  if (role.role === "quote") return false;
  const type = typeForRole(role.role);
  // `pos` usually comes from the document before `tr`'s steps. A position that
  // is already in tr.doc must not be mapped again: the split step would push
  // it into the text, and the markup change would keep only the first character.
  const mapped = placed ? pos : tr.mapping.map(pos);
  const attrs = attrsForStyle(node, type, styleId, role);
  try {
    if (type === nodes.code_block || node.type === nodes.code_block) tr.setBlockType(mapped, mapped + node.nodeSize, type, attrs);
    else tr.setNodeMarkup(mapped, type, attrs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Paragraphs that use `fromId` take `toId` instead. Used when a style is deleted,
 * so the text keeps a style and does not keep a private copy of the old one.
 */
export function replaceStyleUses(fromId: string, toId: string, sheet: readonly ParagraphStyle[]): Command {
  if (!findStyle(sheet, toId)) return () => false;
  return (state, dispatch) => {
    const hits: number[] = [];
    state.doc.descendants((node, pos) => {
      if ((node.isTextblock || node.type === nodes.blockquote) && nodeStyleId(node) === fromId) hits.push(pos);
    });
    if (!hits.length) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    const role = structuralRole(sheet, toId);
    for (const pos of hits.reverse()) {
      const mapped = tr.mapping.map(pos);
      const node = tr.doc.nodeAt(mapped);
      if (!node) continue;
      if (node.type === nodes.blockquote) {
        if (role.role === "quote") tr.setNodeMarkup(mapped, undefined, { ...node.attrs, style: storedStyleId(toId, role) });
        continue;
      }
      if (role.role !== "quote") applyStyleToBlock(tr, pos, node, toId, sheet);
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Apply a named style. The paragraph keeps its own size, spacing and character formatting. */
export function applyStyle(styleId: string, sheet: readonly ParagraphStyle[]): Command {
  if (!findStyle(sheet, styleId)) return () => false;
  const role = structuralRole(sheet, styleId);
  return (state, dispatch) => {
    if (role.role === "quote") return applyQuoteStyle(styleId, role)(state, dispatch);
    const insideQuote = quoteDepth(state) > 0;
    const apply: Command = (current, currentDispatch) => {
      const { from, to } = current.selection;
      if (!currentDispatch) return true;
      const tr = current.tr;
      let applied = false;
      current.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isTextblock) return true;
        applied = applyStyleToBlock(tr, pos, node, styleId, sheet) || applied;
        return false;
      });
      if (applied) currentDispatch(tr.scrollIntoView());
      return applied;
    };
    return insideQuote ? chainCommands(lift, apply)(state, dispatch) : apply(state, dispatch);
  };
}

function quoteDepth(state: EditorState) {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) if ($from.node(depth).type === nodes.blockquote) return depth;
  return 0;
}

function applyQuoteStyle(styleId: string, role: { role: StyleRole; level: number }): Command {
  return (state, dispatch) => {
    const depth = quoteDepth(state);
    if (depth) {
      if (!dispatch) return true;
      const pos = state.selection.$from.before(depth);
      const node = state.selection.$from.node(depth);
      dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, style: storedStyleId(styleId, role) }).scrollIntoView());
      return true;
    }
    let tr: import("prosemirror-state").Transaction | undefined;
    if (!wrapIn(nodes.blockquote!)(state, (next) => { tr = next; })) return false;
    if (!dispatch || !tr) return true;
    const stored = storedStyleId(styleId, role);
    if (stored) {
      const $pos = tr.selection.$from;
      for (let level = $pos.depth; level > 0; level -= 1) {
        if ($pos.node(level).type === nodes.blockquote) {
          tr.setNodeMarkup($pos.before(level), undefined, { style: stored });
          break;
        }
      }
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * Enter keeps the first paragraph's style and gives the new one the style
 * that style names as next (a heading's next style is Normal).
 *
 * A Title splits into two Titles when the caret is not at the end, so the
 * text before the caret stays and the text after it moves into the title
 * below. Enter at the end still opens the following block.
 */
export function splitWithNextStyle(sheet: () => readonly ParagraphStyle[]): Command {
  return (state, dispatch, view) => {
    const { $from, $to } = state.selection;
    const parent = $from.parent;
    if (!parent.isTextblock || !$from.sameParent($to)) return splitBlock(state, dispatch, view);
    const styles = sheet();
    const styleId = nodeStyleId(parent);
    const atEnd = $to.parentOffset === parent.content.size;
    if (structuralRole(styles, styleId).role === "title" && !atEnd) return splitKeepingType(state, dispatch);
    const nextId = resolveStyle(styles, styleId)?.next;
    if (!nextId || nextId === styleId || !findStyle(styles, nextId)) return splitBlock(state, dispatch, view);
    // At the start, the new block is the empty one above. The block that holds
    // the text keeps its style. Anywhere else the caret lands in the new block.
    const atStart = state.selection.empty && $from.parentOffset === 0;
    return splitBlock(
      state,
      dispatch &&
        ((tr) => {
          if (!atStart) {
            const $pos = tr.selection.$from;
            if ($pos.parent.isTextblock) applyStyleToBlock(tr, $pos.before($pos.depth), $pos.parent, nextId, styles, true);
          }
          dispatch(tr.scrollIntoView());
        }),
      view,
    );
  };
}

/** Split one textblock into two of the same type, after deleting a selection. */
function splitKeepingType(state: EditorState, dispatch?: (tr: import("prosemirror-state").Transaction) => void) {
  const { $from, $to } = state.selection;
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return false;
  if (!dispatch) return !state.selection.empty || canSplit(state.doc, $from.pos);
  const tr = state.tr;
  if (!state.selection.empty) tr.deleteSelection();
  const pos = tr.selection.from;
  if (!canSplit(tr.doc, pos)) return false;
  dispatch(tr.split(pos).scrollIntoView());
  return true;
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

/** Caret to the start or end of the document. Always handled, so the browser doesn't move it on its own. */
export function goToDocumentEdge(edge: "start" | "end"): Command {
  return (state, dispatch) => {
    const selection = edge === "end" ? TextSelection.atEnd(state.doc) : TextSelection.atStart(state.doc);
    if (!state.selection.eq(selection)) dispatch?.(state.tr.setSelection(selection).scrollIntoView());
    return true;
  };
}

export const insertHorizontalRule = insertBlock(nodes.horizontal_rule!.create());
export const insertPageBreak = insertBlock(nodes.page_break!.create());

function nextFootnoteLabel(doc: PMNode) {
  let max = 0;
  doc.descendants((node) => {
    const raw = node.type.name === "footnote_ref" ? node.attrs.label : node.attrs.footnote;
    const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : 0;
    if (n > max) max = n;
  });
  return String(max + 1);
}

/** Insert a numbered footnote marker and its note, and put the cursor in the note. */
export const insertFootnote: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false;
  const label = nextFootnoteLabel(state.doc);
  const ref = nodes.footnote_ref!.create({ label });
  const note = nodes.paragraph!.create({ footnote: label });
  if (!dispatch) return true;
  const tr = state.tr.insert(state.selection.to, ref);
  const at = tr.doc.content.size;
  tr.insert(at, note);
  tr.setSelection(TextSelection.create(tr.doc, at + 1));
  dispatch(tr.scrollIntoView());
  return true;
};

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

function storedPictureSize(node: PMNode, value: string | number | null | undefined) {
  if (node.type === nodes.inline_image) {
    if (value == null || value === "") return null;
    const n = typeof value === "number" ? value : Number.parseFloat(String(value));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  return pictureWidth(value);
}

export function setImageAttrs(attrs: Partial<{ width: string | number | null; height: string | number | null; align: Align; alt: string; wrap: PictureWrap | null; crop: PictureCrop | null; rotate: number | null }>): Command {
  return (state, dispatch) => {
    const selection = state.selection;
    if (!(selection instanceof NodeSelection)) return false;
    const node = selection.node;
    if (node.type !== nodes.image && node.type !== nodes.inline_image) return false;
    const next: Record<string, unknown> = { ...node.attrs };
    if ("width" in attrs && "width" in node.attrs) next.width = storedPictureSize(node, attrs.width);
    if ("height" in attrs && "height" in node.attrs) next.height = storedPictureSize(node, attrs.height);
    if ("align" in attrs && node.type === nodes.image) next.align = attrs.align;
    if ("alt" in attrs) next.alt = attrs.alt ?? "";
    if ("wrap" in attrs && node.type === nodes.image) next.wrap = pictureWrap(attrs.wrap);
    if ("crop" in attrs) next.crop = pictureCrop(attrs.crop);
    if ("rotate" in attrs) next.rotate = pictureRotate(attrs.rotate);
    const tr = state.tr.setNodeMarkup(selection.from, undefined, next);
    tr.setSelection(NodeSelection.create(tr.doc, selection.from));
    dispatch?.(tr);
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

/** The href stored for text the user typed into the link field, or null when Inline refuses it. */
export function linkHrefFromInput(raw: string): string | null {
  const trimmed = raw.trim();
  const candidate = fileLinkHref(trimmed) ?? (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed) ? `https://${trimmed}` : trimmed);
  const href = safeHref(candidate);
  return href ? normalizeHref(href) : null;
}

/** Clipboard text that is only a link, or null when it is ordinary text. */
export function clipboardLink(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  return linkHrefFromInput(trimmed);
}

/**
 * Where ⌘K should apply a link. A selection is used as-is, so the selected
 * words stay the link text. A caret inside a link edits that whole link.
 * A caret in plain text is an insertion point.
 */
export function linkEditTarget(state: EditorState): { from: number; to: number; href: string } {
  const { from, to, empty } = state.selection;
  if (!empty) {
    const type = marks.link!;
    let href = "";
    let all = true;
    state.doc.nodesBetween(from, to, (node) => {
      if (!node.isText || !node.text) return;
      const mark = type.isInSet(node.marks);
      if (!mark) {
        all = false;
        return;
      }
      const value = mark.attrs.href as string;
      if (!href) href = value;
      else if (href !== value) all = false;
    });
    return { from, to, href: all ? href : "" };
  }
  const link = linkAt(state);
  if (link) return { from: link.from, to: link.to, href: link.href };
  return { from, to, href: "" };
}

export function setLink(rawHref: string | null, text?: string, range?: { from: number; to: number }): Command {
  const href = rawHref === null ? null : linkHrefFromInput(rawHref);
  return (state, dispatch) => {
    if (rawHref !== null && !href) return false;
    if (!dispatch) return true;
    const type = marks.link!;
    let from: number;
    let to: number;
    if (range && range.from >= 0 && range.to <= state.doc.content.size && range.from <= range.to) {
      from = range.from;
      to = range.to;
    } else {
      const existing = linkAt(state);
      ({ from, to } = existing ?? state.selection);
    }
    const tr = state.tr;
    // Text is inserted only at a caret. A selection is already the link text.
    if (text && from === to) {
      tr.insertText(text, from);
      to = from + text.length;
    }
    if (from === to) return false;
    tr.removeMark(from, to, type);
    if (href) tr.addMark(from, to, type.create({ href }));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export function normalizeHref(href: string) {
  const trimmed = href.trim();
  const file = fileLinkHref(trimmed);
  if (file) return file;
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

/** Insert text at the cursor, such as a special character. */
export function insertText(text: string): Command {
  return (state, dispatch) => {
    dispatch?.(state.tr.insertText(text).scrollIntoView());
    return true;
  };
}

/**
 * Insert a table of contents before the current block. One field, generated
 * from the headings. A document has one; inserting again selects it.
 */
export const insertTableOfContents: Command = (state, dispatch) => {
  const existing = findToc(state.doc);
  if (!dispatch) return true;
  if (existing) {
    const selection = tocTitleSelection(state.doc, existing.pos) ?? TextSelection.create(state.doc, existing.pos + 1);
    dispatch(state.tr.setSelection(selection).scrollIntoView());
    return true;
  }
  const { $from } = state.selection;
  const depth = Math.min(1, $from.depth);
  const at = depth ? $from.before(depth) : state.selection.from;
  const tr = state.tr.insert(at, createToc(state.doc));
  const pos = tr.mapping.map(at, -1);
  const selection = tocTitleSelection(tr.doc, pos) ?? NodeSelection.create(tr.doc, pos);
  dispatch(tr.setSelection(selection).scrollIntoView());
  return true;
};

/** Remove the table of contents. Selecting the field and pressing Delete does the same. */
export const removeTableOfContents: Command = (state, dispatch) => {
  const toc = findToc(state.doc);
  if (!toc) return false;
  if (!dispatch) return true;
  dispatch(state.tr.delete(toc.pos, toc.pos + toc.node.nodeSize).scrollIntoView());
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

/**
 * Open a link that leaves the document. File links go through the desktop
 * app when it is there, because a browser will not open `file://` itself.
 * Web, mail and phone links open in a new tab (the desktop app hands those
 * to the system too).
 */
export function openDocumentLink(href: string) {
  const bridge = typeof window !== "undefined" ? window.inlineDesktop?.openExternal : undefined;
  if (/^file:/i.test(href) && bridge) {
    bridge(href);
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

/** Follow a link: in-document anchors (#block-id) move the cursor there, others open outside the document. */
export function followLink(href: string): Command {
  return (state, dispatch) => {
    if (href.startsWith("#")) {
      const pos = blockPosById(state.doc, href.slice(1));
      if (pos == null) return false;
      dispatch?.(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos + 1))).scrollIntoView());
      return true;
    }
    if (dispatch) openDocumentLink(href);
    return true;
  };
}

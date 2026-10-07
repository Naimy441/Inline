import { Fragment, Mark, type Node as PMNode } from "prosemirror-model";
import type { Transform } from "prosemirror-transform";
import { diffSequences, textSimilarity } from "@/lib/doc/diff";
import { serializeBlock } from "@/lib/doc/markdown";
import { MARKDOWN_MARKS, RANGE_MARKS, isTextblockType, schema } from "@/lib/doc/schema";

/**
 * Applies new content to a run of blocks while preserving everything the new
 * content doesn't say. New content usually comes from Markdown written by the
 * agent, which can't express colors, fonts, comment anchors, locks, block ids
 * or spacing; those are carried over from the old blocks wherever the text is
 * unchanged, and inherited by new text from its neighbours.
 *
 * Changes are applied as small, local steps (one per changed block region) so
 * concurrent typing elsewhere is unaffected and review hunks stay precise.
 */

export class LockedContentError extends Error {
  constructor() {
    super("That text is locked from AI edits. Leave locked passages unchanged.");
  }
}

const STYLE_MARKS = new Set(["text_color", "font_family", "font_size"]);
/** Block attributes that Markdown carries; the rest are preserved from the old block. */
const MARKDOWN_BLOCK_ATTRS = new Set(["align", "indent", "level"]);

type Pair = { old?: PMNode; next?: PMNode };

/**
 * Replace the top-level blocks [fromIndex, toIndex) of `tr.doc` with `blocks`.
 * Returns false if nothing changed.
 */
export function replaceTopLevelBlocks(tr: Transform, fromIndex: number, toIndex: number, blocks: readonly PMNode[]): boolean {
  const doc = tr.doc;
  const oldBlocks: PMNode[] = [];
  const positions: number[] = [];
  let pos = 0;
  doc.forEach((node, offset, index) => {
    if (index === fromIndex) pos = offset;
    if (index >= fromIndex && index < toIndex) {
      oldBlocks.push(node);
      positions.push(offset);
    }
  });
  if (fromIndex >= doc.childCount) pos = doc.content.size;
  const nextBlocks = blocks.length || doc.childCount - (toIndex - fromIndex) > 0 ? [...blocks] : [schema.node("paragraph")];
  return applyBlockChanges(tr, pos, oldBlocks, positions, nextBlocks);
}

function applyBlockChanges(tr: Transform, regionStart: number, oldBlocks: PMNode[], positions: number[], nextBlocks: PMNode[]): boolean {
  const pairs = alignBlocks(oldBlocks, nextBlocks);
  // Original start position of each old block, and the insert position for new-only blocks.
  const ops: Array<{ pair: Pair; pos: number }> = [];
  let oldIndex = 0;
  let insertAt = regionStart;
  for (const pair of pairs) {
    if (pair.old) {
      const at = positions[oldIndex]!;
      ops.push({ pair, pos: at });
      insertAt = at + pair.old.nodeSize;
      oldIndex += 1;
    } else {
      ops.push({ pair, pos: insertAt });
    }
  }

  let changed = false;
  const firstStep = tr.steps.length;
  const deletions: Array<{ from: number; to: number }> = [];
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const { pair, pos } = ops[i]!;
    if (pair.old && pair.next) {
      const merged = mergeBlock(pair.old, pair.next);
      if (!merged.eq(pair.old)) {
        replaceNodeMinimal(tr, pos, pair.old, merged);
        changed = true;
      }
    } else if (pair.old) {
      assertUnlocked(pair.old);
      deletions.push({ from: pos, to: pos + pair.old.nodeSize });
    } else if (pair.next) {
      tr.insert(pos, stripIds(pair.next));
      changed = true;
    }
  }
  // Delete after inserting: removing every old block first would leave the
  // document momentarily empty, and ProseMirror fills it with an empty
  // paragraph that then stays behind the new content.
  for (const deletion of deletions) {
    const mapping = tr.mapping.slice(firstStep);
    const from = mapping.map(deletion.from, 1);
    const to = Math.max(from, mapping.map(deletion.to, -1));
    tr.delete(from, to);
    changed = true;
  }
  return changed;
}

/** Replace `oldNode` (at `pos`) with `next`, touching only the part that differs. */
function replaceNodeMinimal(tr: Transform, pos: number, oldNode: PMNode, next: PMNode) {
  if (oldNode.type !== next.type || !attrsEqual(oldNode.attrs, next.attrs)) {
    if (oldNode.type.name === next.type.name || canSetMarkup(oldNode, next)) {
      tr.setNodeMarkup(pos, next.type, next.attrs, oldNode.marks);
    } else {
      tr.replaceWith(pos, pos + oldNode.nodeSize, next);
      return;
    }
  }
  const current = tr.doc.nodeAt(pos);
  if (!current) return;
  const start = current.content.findDiffStart(next.content);
  if (start == null) return;
  const end = current.content.findDiffEnd(next.content);
  let endA = end?.a ?? current.content.size;
  let endB = end?.b ?? next.content.size;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  tr.replace(pos + 1 + start, pos + 1 + endA, next.slice(start, endB));
}

function canSetMarkup(oldNode: PMNode, next: PMNode) {
  return oldNode.isTextblock && next.isTextblock;
}

function attrsEqual(a: Record<string, unknown>, b: Record<string, unknown>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Block alignment
// ---------------------------------------------------------------------------

function blockKey(node: PMNode) {
  return serializeBlock(node);
}

function kind(node: PMNode) {
  if (isTextblockType(node.type.name)) return "text";
  return node.type.name;
}

/** Pair old blocks with new ones: identical blocks first, then similar blocks of the same kind. */
export function alignBlocks(oldBlocks: readonly PMNode[], nextBlocks: readonly PMNode[]): Pair[] {
  const oldKeys = oldBlocks.map(blockKey);
  const nextKeys = nextBlocks.map(blockKey);
  const ops = diffSequences(oldKeys, nextKeys);
  const pairs: Pair[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]!;
    if (op.type === "equal") {
      for (let k = 0; k < op.aEnd - op.aStart; k += 1) pairs.push({ old: oldBlocks[op.aStart + k], next: nextBlocks[op.bStart + k] });
      continue;
    }
    // Gather the whole changed gap (delete and/or insert runs) and pair inside it.
    let aStart = op.aStart;
    let aEnd = op.aEnd;
    let bStart = op.bStart;
    let bEnd = op.bEnd;
    while (i + 1 < ops.length && ops[i + 1]!.type !== "equal") {
      i += 1;
      aStart = Math.min(aStart, ops[i]!.aStart);
      aEnd = Math.max(aEnd, ops[i]!.aEnd);
      bStart = Math.min(bStart, ops[i]!.bStart);
      bEnd = Math.max(bEnd, ops[i]!.bEnd);
    }
    pairs.push(...pairGap(oldBlocks.slice(aStart, aEnd), oldKeys.slice(aStart, aEnd), nextBlocks.slice(bStart, bEnd), nextKeys.slice(bStart, bEnd)));
  }
  return pairs;
}

function pairGap(olds: PMNode[], oldKeys: string[], nexts: PMNode[], nextKeys: string[]): Pair[] {
  const out: Pair[] = [];
  // Same number of blocks of matching kinds: an in-place rewrite, pair them one to one.
  if (olds.length === nexts.length && olds.every((node, i) => kind(node) === kind(nexts[i]!))) {
    for (let i = 0; i < olds.length; i += 1) out.push({ old: olds[i], next: nexts[i] });
    return out;
  }
  let o = 0;
  for (let n = 0; n < nexts.length; n += 1) {
    let match = -1;
    for (let k = o; k < olds.length; k += 1) {
      if (kind(olds[k]!) === kind(nexts[n]!) && textSimilarity(oldKeys[k]!, nextKeys[n]!) >= 0.35) {
        match = k;
        break;
      }
    }
    if (match < 0) {
      out.push({ next: nexts[n] });
      continue;
    }
    for (; o < match; o += 1) out.push({ old: olds[o] });
    out.push({ old: olds[o], next: nexts[n] });
    o += 1;
  }
  for (; o < olds.length; o += 1) out.push({ old: olds[o] });
  return out;
}

// ---------------------------------------------------------------------------
// Block merge
// ---------------------------------------------------------------------------

export function mergeBlock(old: PMNode, next: PMNode): PMNode {
  if (kind(old) !== kind(next)) {
    assertUnlocked(old);
    return withId(next, old.attrs.id);
  }
  if (old.isTextblock) {
    const attrs: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(next.type.spec.attrs ?? {})) {
      if (MARKDOWN_BLOCK_ATTRS.has(key)) attrs[key] = next.attrs[key];
      else if (key in old.attrs) attrs[key] = old.attrs[key];
      else attrs[key] = (spec as { default?: unknown }).default;
    }
    return next.type.create(attrs, mergeInline(old, next));
  }
  switch (old.type.name) {
    case "bullet_list":
    case "ordered_list": {
      const items = mergeChildren(old, next, (a, b) => {
        const children = mergeChildren(a, b);
        return schema.nodes.list_item!.create({ checked: b.attrs.checked }, children);
      });
      // A list's own indents and bullet aren't in Markdown; they stay.
      return next.type.create({ ...next.attrs, id: old.attrs.id, indent: old.attrs.indent ?? null, hanging: old.attrs.hanging ?? null, marker: old.attrs.marker ?? null }, items);
    }
    case "blockquote":
      return next.type.create({ ...next.attrs, id: old.attrs.id }, mergeChildren(old, next));
    case "table":
      return mergeTable(old, next);
    case "image":
    case "code_block":
      return next.type.create({ ...next.attrs, id: old.attrs.id }, next.content);
    default:
      return old.type === next.type ? old : withId(next, old.attrs.id);
  }
}

function mergeChildren(old: PMNode, next: PMNode, mergeChild: (a: PMNode, b: PMNode) => PMNode = mergeBlock): PMNode[] {
  const olds: PMNode[] = [];
  const nexts: PMNode[] = [];
  old.forEach((child) => olds.push(child));
  next.forEach((child) => nexts.push(child));
  const result: PMNode[] = [];
  for (const pair of alignBlocks(olds, nexts)) {
    if (pair.old && pair.next) result.push(mergeChild(pair.old, pair.next));
    else if (pair.next) result.push(pair.next);
    else if (pair.old) assertUnlocked(pair.old);
  }
  return result;
}

function mergeTable(old: PMNode, next: PMNode): PMNode {
  const rows: PMNode[] = [];
  next.forEach((nextRow, _o, rowIndex) => {
    const oldRow = rowIndex < old.childCount ? old.child(rowIndex) : null;
    const cells: PMNode[] = [];
    nextRow.forEach((nextCell, _c, cellIndex) => {
      const oldCell = oldRow && cellIndex < oldRow.childCount ? oldRow.child(cellIndex) : null;
      if (!oldCell) {
        cells.push(nextCell);
        return;
      }
      cells.push(oldCell.type.create(oldCell.attrs, mergeChildren(oldCell, nextCell)));
    });
    rows.push((oldRow ?? nextRow).type.create((oldRow ?? nextRow).attrs, cells));
  });
  for (let r = next.childCount; r < old.childCount; r += 1) assertUnlocked(old.child(r));
  return old.type.create({ ...old.attrs }, rows);
}

function withId(node: PMNode, id: unknown) {
  if (!("id" in node.attrs)) return node;
  return node.type.create({ ...node.attrs, id: id ?? null }, node.content, node.marks);
}

function stripIds(node: PMNode): PMNode {
  if (!("id" in node.attrs) || node.attrs.id == null) return node;
  return node.type.create({ ...node.attrs, id: null }, node.content, node.marks);
}

function assertUnlocked(node: PMNode) {
  let locked = false;
  node.descendants((child) => {
    if (locked) return false;
    if (child.marks.some((mark) => mark.type.name === "locked")) locked = true;
    return !locked;
  });
  if (locked) throw new LockedContentError();
}

// ---------------------------------------------------------------------------
// Inline merge
// ---------------------------------------------------------------------------

type Atom = { key: string; marks: readonly Mark[]; node?: PMNode };

function atomsOf(block: PMNode): Atom[] {
  const atoms: Atom[] = [];
  block.forEach((child) => {
    if (child.isText) {
      for (const ch of child.text ?? "") atoms.push({ key: ch, marks: child.marks });
    } else {
      atoms.push({ key: `\u0000${child.type.name}`, marks: child.marks, node: child });
    }
  });
  return atoms;
}

function hasLock(atom: Atom | undefined) {
  return Boolean(atom?.marks.some((mark) => mark.type.name === "locked"));
}

/**
 * Character-level merge: unchanged characters keep their old styling (with the
 * Markdown-expressible marks taken from the new text), inserted characters
 * take the new Markdown marks plus styling inherited from what they replace or
 * sit next to.
 */
export function mergeInline(old: PMNode, next: PMNode): Fragment {
  const a = atomsOf(old);
  const b = atomsOf(next);
  const ops = wordDiff(a, b);
  const out: Atom[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]!;
    if (op.type === "equal") {
      for (let k = 0; k < op.aEnd - op.aStart; k += 1) {
        const before = a[op.aStart + k]!;
        const after = b[op.bStart + k]!;
        // Markdown can't say how a space is formatted (bold or italic around spaces alone), so an unchanged one keeps its own.
        const space = !before.node && /^\s$/.test(before.key) && !after.marks.some((mark) => mark.type.name === "code" || mark.type.name === "math");
        out.push({ key: after.key, node: before.node ?? after.node, marks: space ? before.marks : combineMarks(before.marks, after.marks) });
      }
      continue;
    }
    if (op.type === "delete") {
      for (let k = op.aStart; k < op.aEnd; k += 1) if (hasLock(a[k])) throw new LockedContentError();
      continue;
    }
    // Insert: find the styling source. Prefer the text this insertion replaces.
    const prevOp = ops[i - 1];
    const nextOp = ops[i + 1];
    const replaced = prevOp?.type === "delete" ? a[prevOp.aStart] : nextOp?.type === "delete" ? a[nextOp.aStart] : undefined;
    const before = op.aStart > 0 ? a[op.aStart - 1] : undefined;
    const after = op.aStart < a.length ? a[op.aStart] : undefined;
    const lockedInside = hasLock(before) && hasLock(after) && sharedRange(before!, after!, "locked");
    if (lockedInside) throw new LockedContentError();
    const styleSource = replaced ?? before ?? after;
    for (let k = op.bStart; k < op.bEnd; k += 1) {
      const atom = b[k]!;
      const inherited: Mark[] = [];
      for (const mark of styleSource?.marks ?? []) if (STYLE_MARKS.has(mark.type.name)) inherited.push(mark);
      // Range marks (comments) extend only when the insertion is strictly inside the range.
      if (before && after) {
        for (const mark of before.marks) {
          if (mark.type.name === "comment" && after.marks.some((m) => m.eq(mark))) inherited.push(mark);
        }
      }
      let marks = Mark.setFrom(atom.marks.filter((mark) => MARKDOWN_MARKS.has(mark.type.name)));
      for (const mark of inherited) if (!mark.isInSet(marks) && canAddMark(marks, mark)) marks = mark.addToSet(marks);
      out.push({ key: atom.key, node: atom.node, marks });
    }
  }
  return buildFragment(out);
}

const WORD_CHAR = /[\p{L}\p{N}_'’]/u;

/** Group atoms into words, whitespace runs and single symbols: [start, end) atom ranges. */
function tokenize(atoms: Atom[]): Array<[number, number]> {
  const tokens: Array<[number, number]> = [];
  let i = 0;
  while (i < atoms.length) {
    const key = atoms[i]!.key;
    let j = i + 1;
    if (key.length === 1 && WORD_CHAR.test(key)) {
      while (j < atoms.length && atoms[j]!.key.length === 1 && WORD_CHAR.test(atoms[j]!.key)) j += 1;
    } else if (key.length === 1 && /\s/.test(key)) {
      while (j < atoms.length && atoms[j]!.key.length === 1 && /\s/.test(atoms[j]!.key)) j += 1;
    }
    tokens.push([i, j]);
    i = j;
  }
  return tokens;
}

/** Word-level diff expressed in atom indices, so replaced words map to replacing words cleanly. */
function wordDiff(a: Atom[], b: Atom[]) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const key = (atoms: Atom[], [s, e]: [number, number]) => atoms.slice(s, e).map((atom) => atom.key).join("");
  const ops = diffSequences(
    ta.map((token) => key(a, token)),
    tb.map((token) => key(b, token)),
  );
  return ops.map((op) => ({
    type: op.type,
    aStart: op.aStart < ta.length ? ta[op.aStart]![0] : a.length,
    aEnd: op.aEnd > 0 ? ta[op.aEnd - 1]![1] : 0,
    bStart: op.bStart < tb.length ? tb[op.bStart]![0] : b.length,
    bEnd: op.bEnd > 0 ? tb[op.bEnd - 1]![1] : 0,
  })).map((op) => ({
    ...op,
    aEnd: Math.max(op.aStart, op.aEnd),
    bEnd: Math.max(op.bStart, op.bEnd),
  }));
}

function sharedRange(a: Atom, b: Atom, name: string) {
  return a.marks.some((mark) => mark.type.name === name && b.marks.some((other) => other.eq(mark)));
}

function canAddMark(set: readonly Mark[], mark: Mark) {
  return !set.some((existing) => existing.type.excludes(mark.type) && existing.type !== mark.type);
}

function combineMarks(oldMarks: readonly Mark[], newMarks: readonly Mark[]): readonly Mark[] {
  let set: readonly Mark[] = Mark.none;
  for (const mark of newMarks) {
    if (!MARKDOWN_MARKS.has(mark.type.name)) continue;
    // Keep the old instance when it is the same kind of mark (preserves highlight colors, link titles).
    const previous = oldMarks.find((m) => m.type === mark.type);
    const keepOld = previous && (mark.type.name !== "link" || previous.attrs.href === mark.attrs.href);
    set = (keepOld ? previous : mark).addToSet(set);
  }
  for (const mark of oldMarks) {
    if (MARKDOWN_MARKS.has(mark.type.name)) continue;
    if (STYLE_MARKS.has(mark.type.name) || RANGE_MARKS.has(mark.type.name)) {
      if (canAddMark(set, mark)) set = mark.addToSet(set);
    }
  }
  return set;
}

function buildFragment(atoms: Atom[]): Fragment {
  const nodes: PMNode[] = [];
  let text = "";
  let marks: readonly Mark[] | null = null;
  const flush = () => {
    if (text) nodes.push(schema.text(text, marks ?? Mark.none));
    text = "";
    marks = null;
  };
  for (const atom of atoms) {
    if (atom.node) {
      flush();
      nodes.push(atom.node.mark(atom.marks));
      continue;
    }
    if (marks && !Mark.sameSet(marks, atom.marks)) flush();
    marks = atom.marks;
    text += atom.key;
  }
  flush();
  return Fragment.fromArray(nodes);
}

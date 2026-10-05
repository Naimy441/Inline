import { ChangeSet, simplifyChanges, type TokenEncoder } from "prosemirror-changeset";
import { Slice, type Mark, type Node as PMNode, type Schema } from "prosemirror-model";
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  Transform,
  type Mappable,
} from "prosemirror-transform";
import { newId } from "@/lib/doc/ids";

/**
 * Pending agent changes ("hunks") awaiting the user's keep/undo decision.
 * Agent edits are applied to the document immediately (so the user and the
 * agent both see the live result); each hunk remembers the content it
 * replaced so it can be reverted independently, Cursor-style.
 *
 * Hunk positions are kept in the coordinates of the current document and
 * are mapped through every subsequent change, by anyone.
 */

export type Hunk = {
  id: string;
  /** Range of the new content in the current document. */
  from: number;
  to: number;
  /** The content this hunk replaced (restored on undo). */
  deleted: Slice;
  /** Who made the change: a chat id, or "external" for MCP clients. */
  author: string;
  createdAt: number;
};

export type HunkJSON = Omit<Hunk, "deleted"> & { deleted: ReturnType<Slice["toJSON"]>; deletedText: string; insertedText?: string };

function markKey(marks: readonly Mark[]) {
  return marks.map((mark) => `${mark.type.name}${Object.keys(mark.attrs).length ? JSON.stringify(mark.attrs) : ""}`).join(",");
}

function attrKey(node: PMNode) {
  const { id: _id, ...attrs } = node.attrs as Record<string, unknown>;
  return `${node.type.name}${JSON.stringify(attrs)}`;
}

/** Compares characters with their marks and nodes with their attributes (ids excluded). */
const encoder: TokenEncoder<string | number> = {
  encodeCharacter: (char, marks) => (marks.length ? `${char}|${markKey(marks)}` : char),
  encodeNodeStart: (node) => attrKey(node),
  encodeNodeEnd: (node) => `/${node.type.name}`,
  compareTokens: (a, b) => a === b,
};

type Range = { fromA: number; toA: number; fromB: number; toB: number };

/** Ranges changed by `tr`, in before (A) and after (B) coordinates, simplified to word boundaries. */
export function changedRanges(before: PMNode, tr: Transform): Range[] {
  const after = tr.doc;
  const set = ChangeSet.create(before, undefined, encoder).addSteps(after, tr.mapping.maps, null);
  const ranges: Range[] = simplifyChanges(set.changes, after).map((change) => ({
    fromA: change.fromA,
    toA: change.toA,
    fromB: change.fromB,
    toB: change.toB,
  }));

  // Mark and attribute steps have empty step maps, so the change set can't see them.
  const inverse = tr.mapping.invert();
  tr.steps.forEach((step, index) => {
    let range: { from: number; to: number } | null = null;
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) range = { from: step.from, to: step.to };
    else if (step instanceof AttrStep || step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep) {
      const node = tr.docs[index]!.nodeAt(step.pos);
      range = { from: step.pos, to: step.pos + (node?.nodeSize ?? 1) };
    } else if (step instanceof ReplaceAroundStep && (step as unknown as { structure: boolean }).structure) {
      range = { from: step.from, to: step.to };
    }
    if (!range) return;
    const rest = tr.mapping.slice(index + 1);
    const fromB = rest.map(range.from, 1);
    const toB = Math.max(fromB, rest.map(range.to, -1));
    if (fromB >= toB) return;
    ranges.push({ fromA: inverse.map(fromB, 1), toA: Math.max(inverse.map(fromB, 1), inverse.map(toB, -1)), fromB, toB });
  });

  ranges.sort((a, b) => a.fromB - b.fromB || a.toB - b.toB);
  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    // Adjacent word changes separated only by whitespace read as one change.
    const gap = last && range.fromB > last.toB ? safeText(after, last.toB, range.fromB) : null;
    if (last && (range.fromB <= last.toB || (gap !== null && /^[\s,.;:]?\s*$/.test(gap) && gap.length <= 2))) {
      last.toB = Math.max(last.toB, range.toB);
      last.fromA = Math.min(last.fromA, range.fromA);
      last.toA = Math.max(last.toA, range.toA);
    } else {
      merged.push({ ...range });
    }
  }
  return merged.filter((range) => !(range.fromA === range.toA && range.fromB === range.toB));
}

function safeText(doc: PMNode, from: number, to: number): string | null {
  // Only merge within a single textblock.
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return null;
  return doc.textBetween(from, to);
}

export function mapHunks(hunks: readonly Hunk[], mapping: Mappable): Hunk[] {
  const out: Hunk[] = [];
  for (const hunk of hunks) {
    const from = mapping.map(hunk.from, 1);
    const to = Math.max(from, mapping.map(hunk.to, -1));
    if (from === to && hunk.deleted.size === 0) continue;
    out.push({ ...hunk, from, to });
  }
  return out;
}

/**
 * Record the changes made by an agent transaction as hunks, merging them with
 * existing hunks they overlap so a single undo always restores the text the
 * user last accepted.
 */
export function recordAgentChange(before: PMNode, tr: Transform, existing: readonly Hunk[], author: string, now = Date.now()): Hunk[] {
  const ranges = changedRanges(before, tr);
  if (!ranges.length) return mapHunks(existing, tr.mapping);

  // Existing hunks are in `before` coordinates.
  const pending = [...existing].sort((a, b) => a.from - b.from);
  const absorbed = new Set<string>();
  const created: Hunk[] = [];

  for (const range of ranges) {
    let fromA = range.fromA;
    let toA = range.toA;
    // Grow the region until it no longer touches any other pending hunk.
    let grew = true;
    const group: Hunk[] = [];
    while (grew) {
      grew = false;
      for (const hunk of pending) {
        if (absorbed.has(hunk.id) || group.includes(hunk)) continue;
        if (hunk.from <= toA && fromA <= hunk.to) {
          group.push(hunk);
          fromA = Math.min(fromA, hunk.from);
          toA = Math.max(toA, hunk.to);
          grew = true;
        }
      }
    }
    for (const hunk of group) absorbed.add(hunk.id);

    // Reconstruct what the region looked like before any of the grouped hunks.
    const original = new Transform(before);
    for (const hunk of [...group].sort((a, b) => b.from - a.from)) original.replace(hunk.from, hunk.to, hunk.deleted);
    const origFrom = original.mapping.map(fromA, -1);
    const origTo = original.mapping.map(toA, 1);
    const deleted = original.doc.slice(origFrom, Math.max(origFrom, origTo));

    const fromB = tr.mapping.map(fromA, -1);
    const toB = Math.max(fromB, tr.mapping.map(toA, 1));
    created.push({
      id: group[0]?.id ?? newId(10),
      from: Math.min(fromB, range.fromB),
      to: Math.max(toB, range.toB),
      deleted,
      author,
      createdAt: group[0]?.createdAt ?? now,
    });
  }

  const untouched = mapHunks(
    pending.filter((hunk) => !absorbed.has(hunk.id)),
    tr.mapping,
  );
  // A merged hunk whose content ended up identical to the original is no change at all.
  const live = created.filter((hunk) => !sliceEqualsRange(hunk.deleted, tr.doc, hunk.from, hunk.to));
  return [...untouched, ...live].sort((a, b) => a.from - b.from);
}

function sliceEqualsRange(slice: Slice, doc: PMNode, from: number, to: number) {
  const current = doc.slice(from, to);
  return current.openStart === slice.openStart && current.openEnd === slice.openEnd && current.content.eq(slice.content);
}

/** Undo the given hunks. Returns the transform and the hunks that remain pending. */
export function rejectHunks(doc: PMNode, hunks: readonly Hunk[], ids: ReadonlySet<string> | "all"): { tr: Transform; remaining: Hunk[] } {
  const tr = new Transform(doc);
  const targets = hunks.filter((hunk) => ids === "all" || ids.has(hunk.id)).sort((a, b) => b.from - a.from);
  let remaining = hunks.filter((hunk) => !(ids === "all" || ids.has(hunk.id)));
  for (const hunk of targets) {
    const from = tr.mapping.map(hunk.from, 1);
    const to = Math.max(from, tr.mapping.map(hunk.to, -1));
    const before = tr.steps.length;
    try {
      tr.replace(from, to, hunk.deleted);
    } catch {
      // Content no longer fits where it came from (the structure changed around it); leave it.
      continue;
    }
    for (let i = before; i < tr.steps.length; i += 1) remaining = mapHunks(remaining, tr.steps[i]!.getMap());
  }
  return { tr, remaining };
}

export function acceptHunks(hunks: readonly Hunk[], ids: ReadonlySet<string> | "all"): Hunk[] {
  return ids === "all" ? [] : hunks.filter((hunk) => !ids.has(hunk.id));
}

export function hunkToJSON(hunk: Hunk, doc: PMNode): HunkJSON {
  const deletedText = hunk.deleted.content.textBetween(0, hunk.deleted.content.size, "\n");
  let insertedText = "";
  try {
    insertedText = doc.textBetween(hunk.from, hunk.to, "\n");
  } catch {
    insertedText = "";
  }
  return { ...hunk, deleted: hunk.deleted.toJSON(), deletedText, insertedText };
}

export function hunkFromJSON(json: HunkJSON, schema: Schema): Hunk {
  return {
    id: json.id,
    from: json.from,
    to: json.to,
    author: json.author,
    createdAt: json.createdAt,
    deleted: Slice.fromJSON(schema, json.deleted),
  };
}

/**
 * Readable text diff for comparing a saved version with the current document:
 * paragraphs are matched first, then words inside paragraphs that changed.
 */

export type DiffPart = { kind: "same" | "insert" | "delete"; text: string };
/** One paragraph of the comparison; `parts` mark what changed inside it. */
export type DiffParagraph = { kind: "same" | "insert" | "delete" | "changed"; parts: DiffPart[] };

const MAX_CELLS = 4_000_000;

/** Longest-common-subsequence alignment of two token lists, as runs of same/insert/delete. */
function align(a: readonly string[], b: readonly string[]): Array<{ kind: DiffPart["kind"]; a: number; b: number }> {
  // Trim the common prefix and suffix so the table only covers the changed middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const ops: Array<{ kind: DiffPart["kind"]; a: number; b: number }> = [];
  for (let i = 0; i < start; i += 1) ops.push({ kind: "same", a: i, b: i });
  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_CELLS) {
    // Too large to align precisely: show the middle as replaced.
    for (let i = start; i < endA; i += 1) ops.push({ kind: "delete", a: i, b: -1 });
    for (let j = start; j < endB; j += 1) ops.push({ kind: "insert", a: -1, b: j });
  } else {
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i]![j] = a[start + i] === b[start + j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        ops.push({ kind: "same", a: start + i, b: start + j });
        i += 1;
        j += 1;
      } else if (i < n && (j >= m || table[i + 1]![j]! >= table[i]![j + 1]!)) {
        // Deletions before insertions, so a replacement reads "old → new".
        ops.push({ kind: "delete", a: start + i, b: -1 });
        i += 1;
      } else {
        ops.push({ kind: "insert", a: -1, b: start + j });
        j += 1;
      }
    }
  }
  for (let k = 0; k < a.length - endA; k += 1) ops.push({ kind: "same", a: endA + k, b: endB + k });
  return ops;
}

function tokens(text: string) {
  return text.match(/\s+|[\p{L}\p{N}'’-]+|[^\s\p{L}\p{N}]/gu) ?? [];
}

/** Word-level diff of two strings, with neighbouring parts of the same kind merged. */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  const parts: DiffPart[] = [];
  for (const op of align(a, b)) {
    const text = op.kind === "insert" ? b[op.b]! : a[op.a]!;
    const last = parts[parts.length - 1];
    if (last && last.kind === op.kind) last.text += text;
    else parts.push({ kind: op.kind, text });
  }
  return parts;
}

/** Paragraph-by-paragraph comparison of two plain texts (paragraphs separated by newlines). */
export function diffParagraphs(before: string, after: string): DiffParagraph[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const result: DiffParagraph[] = [];
  const ops = align(a, b);
  for (let k = 0; k < ops.length; k += 1) {
    const op = ops[k]!;
    if (op.kind === "same") {
      result.push({ kind: "same", parts: [{ kind: "same", text: a[op.a]! }] });
      continue;
    }
    // Pair a run of deleted paragraphs with the inserted run after it, so edited paragraphs show word changes.
    const deleted: string[] = [];
    const inserted: string[] = [];
    while (k < ops.length && ops[k]!.kind !== "same") {
      const run = ops[k]!;
      if (run.kind === "delete") deleted.push(a[run.a]!);
      else inserted.push(b[run.b]!);
      k += 1;
    }
    k -= 1;
    const pairs = Math.min(deleted.length, inserted.length);
    for (let p = 0; p < pairs; p += 1) result.push({ kind: "changed", parts: diffWords(deleted[p]!, inserted[p]!) });
    for (const text of deleted.slice(pairs)) result.push({ kind: "delete", parts: [{ kind: "delete", text }] });
    for (const text of inserted.slice(pairs)) result.push({ kind: "insert", parts: [{ kind: "insert", text }] });
  }
  return result;
}

/** Words added and removed, for a one-line summary. */
export function diffStats(paragraphs: readonly DiffParagraph[]) {
  let added = 0;
  let removed = 0;
  for (const paragraph of paragraphs) {
    for (const part of paragraph.parts) {
      const words = part.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
      if (part.kind === "insert") added += words;
      else if (part.kind === "delete") removed += words;
    }
  }
  return { added, removed };
}

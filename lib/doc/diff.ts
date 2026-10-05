export type DiffOp = { type: "equal" | "delete" | "insert"; aStart: number; aEnd: number; bStart: number; bEnd: number };

/**
 * Myers diff over two sequences. Returns runs of equal / deleted / inserted
 * items. When the edit distance exceeds `maxCost`, the unmatched middle is
 * reported as one delete + insert pair so pathological inputs stay fast.
 */
export function diffSequences<T>(a: readonly T[], b: readonly T[], equals: (x: T, y: T) => boolean = Object.is, maxCost = 1500): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && equals(a[start]!, b[start]!)) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && equals(a[endA - 1]!, b[endB - 1]!)) {
    endA -= 1;
    endB -= 1;
  }

  const ops: DiffOp[] = [];
  if (start > 0) ops.push({ type: "equal", aStart: 0, aEnd: start, bStart: 0, bEnd: start });
  ops.push(...myers(a, b, start, endA, start, endB, equals, maxCost));
  if (endA < a.length) ops.push({ type: "equal", aStart: endA, aEnd: a.length, bStart: endB, bEnd: b.length });
  return coalesce(ops);
}

function myers<T>(a: readonly T[], b: readonly T[], aLo: number, aHi: number, bLo: number, bHi: number, equals: (x: T, y: T) => boolean, maxCost: number): DiffOp[] {
  const n = aHi - aLo;
  const m = bHi - bLo;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ type: "insert", aStart: aLo, aEnd: aLo, bStart: bLo, bEnd: bHi }];
  if (m === 0) return [{ type: "delete", aStart: aLo, aEnd: aHi, bStart: bLo, bEnd: bLo }];

  const max = Math.min(n + m, maxCost);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && equals(a[aLo + x]!, b[bLo + y]!)) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  if (!found) {
    return [
      { type: "delete", aStart: aLo, aEnd: aHi, bStart: bLo, bEnd: bLo },
      { type: "insert", aStart: aHi, aEnd: aHi, bStart: bLo, bEnd: bHi },
    ];
  }

  // Backtrack.
  const steps: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      steps.push({ type: "equal", aStart: aLo + x - 1, aEnd: aLo + x, bStart: bLo + y - 1, bEnd: bLo + y });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === prevX) steps.push({ type: "insert", aStart: aLo + x, aEnd: aLo + x, bStart: bLo + prevY, bEnd: bLo + y });
      else steps.push({ type: "delete", aStart: aLo + prevX, aEnd: aLo + x, bStart: bLo + y, bEnd: bLo + y });
    }
    x = prevX;
    y = prevY;
  }
  return steps.reverse();
}

function coalesce(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const op of ops) {
    if (op.aStart === op.aEnd && op.bStart === op.bEnd) continue;
    const prev = out[out.length - 1];
    if (prev && prev.type === op.type && prev.aEnd === op.aStart && prev.bEnd === op.bStart) {
      prev.aEnd = op.aEnd;
      prev.bEnd = op.bEnd;
    } else {
      out.push({ ...op });
    }
  }
  return out;
}

/** Similarity in [0, 1] based on shared words; cheap enough to run on many block pairs. */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const wordsA = a.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  const wordsB = b.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  if (!wordsA.length && !wordsB.length) return a.trim() === b.trim() ? 1 : 0.5;
  if (!wordsA.length || !wordsB.length) return 0;
  const counts = new Map<string, number>();
  for (const word of wordsA) counts.set(word, (counts.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of wordsB) {
    const count = counts.get(word) ?? 0;
    if (count > 0) {
      shared += 1;
      counts.set(word, count - 1);
    }
  }
  return (2 * shared) / (wordsA.length + wordsB.length);
}

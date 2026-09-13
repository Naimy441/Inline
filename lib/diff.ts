export type DiffPart = { type: "same" | "add" | "del"; text: string };

export function diffWords(original: string, next: string): DiffPart[] {
  const left = tokenize(original);
  const right = tokenize(next);
  if (left.length * right.length > 250_000) {
    return [
      { type: "del", text: original },
      { type: "add", text: next },
    ];
  }

  const n = left.length;
  const m = right.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      push(parts, "same", left[i]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(parts, "del", left[i]);
      i += 1;
    } else {
      push(parts, "add", right[j]);
      j += 1;
    }
  }
  while (i < n) {
    push(parts, "del", left[i]);
    i += 1;
  }
  while (j < m) {
    push(parts, "add", right[j]);
    j += 1;
  }
  return parts;
}

function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((part) => part.length > 0);
}

function push(parts: DiffPart[], type: DiffPart["type"], text: string) {
  const last = parts[parts.length - 1];
  if (last && last.type === type) {
    last.text += text;
    return;
  }
  parts.push({ type, text });
}

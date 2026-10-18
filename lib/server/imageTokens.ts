/**
 * The size Claude resizes an image to before padding, from Anthropic's
 * published rule. Defaults are the standard tier (1568 px / 1568 tokens),
 * which is also under the high-resolution cap, so a preview never pays the
 * high-res maximum of 4,784 tokens. Images that already fit are unchanged.
 */
export function countImageTokens(width: number, height: number): number {
  return Math.ceil(width / 28) * Math.ceil(height / 28);
}

/** Round half to even, matching Python's round() and the live API. */
function roundTiesToEven(value: number): number {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

export function resizedSize(width: number, height: number, maxEdge = 1568, maxTokens = 1568): [number, number] {
  const fits = (w: number, h: number) =>
    Math.ceil(w / 28) * 28 <= maxEdge && Math.ceil(h / 28) * 28 <= maxEdge && countImageTokens(w, h) <= maxTokens;
  if (fits(width, height)) return [width, height];
  if (height > width) {
    const [resizedH, resizedW] = resizedSize(height, width, maxEdge, maxTokens);
    return [resizedW, resizedH];
  }
  const aspectRatio = width / height;
  let lo = 1;
  let hi = width;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, Math.max(roundTiesToEven(mid / aspectRatio), 1))) lo = mid;
    else hi = mid;
  }
  return [lo, Math.max(roundTiesToEven(lo / aspectRatio), 1)];
}

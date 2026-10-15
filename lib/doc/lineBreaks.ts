import type { Node as PMNode } from "prosemirror-model";

/**
 * Line breaks kept from a PDF. A paragraph rebuilt from a PDF holds where
 * each of its lines started there (`lineBreaks`, a block attribute), so it
 * breaks where the original did — TeX and the page break lines differently,
 * even in the same font — until its text is edited: the breaks carry a
 * fingerprint of the text they were taken for, and a paragraph whose text no
 * longer matches it flows freely again (lib/editor/lineFit.ts).
 *
 * Encoded as "<fingerprint>:<offset>,<offset>,…": offsets into the
 * paragraph's content where a line starts; "~" before one marks a break
 * inside a word (the line before it ends with a hyphen).
 */

export type LineBreaks = { key: string; breaks: Array<{ at: number; hyphen: boolean }> };

/** A short fingerprint of a paragraph's text (FNV-1a). */
export function textKey(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function encodeLineBreaks(node: PMNode, breaks: Array<{ at: number; hyphen: boolean }>) {
  return `${textKey(node.textContent)}:${breaks.map((item) => `${item.hyphen ? "~" : ""}${item.at}`).join(",")}`;
}

export function decodeLineBreaks(value: unknown): LineBreaks | null {
  if (typeof value !== "string") return null;
  const match = /^([0-9a-z]+):((?:~?\d+)(?:,~?\d+)*)$/.exec(value);
  if (!match) return null;
  const breaks = match[2]!.split(",").map((part) => ({ at: Number(part.replace("~", "")), hyphen: part.startsWith("~") }));
  for (let i = 1; i < breaks.length; i += 1) if (breaks[i]!.at <= breaks[i - 1]!.at) return null;
  return { key: match[1]!, breaks };
}

/** The paragraph's kept line breaks, if its text is still the text they were kept for. */
export function liveLineBreaks(node: PMNode): LineBreaks | null {
  const decoded = decodeLineBreaks(node.attrs.lineBreaks);
  if (!decoded || decoded.key !== textKey(node.textContent)) return null;
  if (decoded.breaks.some((item) => item.at <= 0 || item.at >= node.content.size)) return null;
  return decoded;
}

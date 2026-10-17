import type { Mark, Node as PMNode } from "prosemirror-model";
import { BLOCK_SEPARATOR, EMPTY_PARAGRAPH, serializeBlock, serializeInline } from "@/lib/doc/markdown";
import { MATH_LANGUAGE, schema, type Borders, type BorderLine, type TabStop } from "@/lib/doc/schema";

/**
 * Blocks as layout Markdown: the Markdown Claude writes an imported PDF's
 * pages in (lib/agent/pdfTools.ts), with every layout attribute and style
 * written out — sizes, spacing, indents, frames, tab stops, colors, fonts and
 * sized pictures — where the usual Markdown view (lib/doc/markdown.ts) leaves
 * them out. Parsing what this writes (parseMarkdown) gives the same blocks
 * back, so a page can be shown as it is and edited a piece at a time.
 */

export function serializeLayoutBlocks(nodes: readonly PMNode[]): string {
  return nodes.map(serializeLayoutBlock).join(BLOCK_SEPARATOR);
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Marks a {…} suffix or a <span style> can carry, rather than Markdown. */
const STYLE_MARKS = new Set(["text_color", "font_family", "font_size", "highlight"]);

export function serializeLayoutBlock(node: PMNode): string {
  switch (node.type.name) {
    case "paragraph":
    case "heading":
    case "title":
    case "subtitle": {
      const shared = sharedStyle(node);
      const text = layoutInline(node, shared, node.type.name === "paragraph");
      const tokens = [...(node.type.name === "title" || node.type.name === "subtitle" ? [`.${node.type.name}`] : []), ...blockTokens(node), ...styleTokens(shared)];
      const suffix = tokens.length ? ` {${tokens.join(" ")}}` : "";
      if (node.type.name === "heading") return `${"#".repeat(Math.max(1, Math.min(6, Number(node.attrs.level) || 1)))} ${text}${suffix}`;
      if (node.type.name === "title") return `# ${text || EMPTY_PARAGRAPH}${suffix}`;
      return `${text || EMPTY_PARAGRAPH}${suffix}`;
    }
    case "code_block": {
      if (node.attrs.language !== MATH_LANGUAGE) return serializeBlock(node);
      const spacing = [node.attrs.spaceBefore != null ? `before=${node.attrs.spaceBefore}` : "", node.attrs.spaceAfter != null ? `after=${node.attrs.spaceAfter}` : ""].filter(Boolean);
      return `$$\n${node.textContent}\n$$${spacing.length ? ` {${spacing.join(" ")}}` : ""}`;
    }
    default:
      return serializeBlock(node);
  }
}

/** A paragraph's layout as {…} tokens: what layoutAttrs (lib/doc/markdown.ts) reads back. */
function blockTokens(node: PMNode): string[] {
  const tokens: string[] = [];
  const { align, indent, textIndent, dir, fontSize, spaceBefore, spaceAfter, lineHeight } = node.attrs;
  if (align && align !== "left") tokens.push(`align=${align}`);
  if (Number(indent)) tokens.push(`left=${Math.round(Number(indent) * 36 * 10) / 10}`);
  if (Number(textIndent) > 0) tokens.push(`first-line=${round(Number(textIndent))}`);
  if (Number(textIndent) < 0) tokens.push(`hanging=${round(-Number(textIndent))}`);
  if (dir === "rtl") tokens.push("dir=rtl");
  if (fontSize != null) tokens.push(`size=${fontSize}`);
  if (lineHeight != null) tokens.push(`line=${lineHeight}`);
  if (node.attrs.keepNext) tokens.push(".keep-next");
  if (node.attrs.keepLines) tokens.push(".keep-lines");
  if (node.attrs.widowControl === false) tokens.push(".widows-off");
  if (node.attrs.pageBreakBefore) tokens.push(".break-before");
  tokens.push(...borderTokens(node.attrs.borders as Borders | null));
  const tabs = node.attrs.tabs as TabStop[] | null;
  if (tabs?.length) tokens.push(`tabs="${tabs.map((tab) => [tab.pos, tab.align, tab.leader].filter(Boolean).join(":")).join(" ")}"`);
  if (spaceBefore != null) tokens.push(`before=${spaceBefore}`);
  if (spaceAfter != null) tokens.push(`after=${spaceAfter}`);
  return tokens;
}

const SIDES = ["top", "bottom", "left", "right"] as const;

function borderTokens(borders: Borders | null): string[] {
  const sides = SIDES.filter((side) => borders?.[side]);
  if (!borders || !sides.length) return [];
  const first = borders[sides[0]!]!;
  const same = (line: BorderLine) => line.style === first.style && line.width === first.width && line.color === first.color;
  if (!sides.every((side) => same(borders[side]!))) {
    // Sides that differ in more than their space: each its own.
    return [`border="${sides.join(" ")}"`, `border-width=${first.width}`, `border-space=${first.space}`];
  }
  // The space most sides have, and each other side's own.
  const counts = new Map<number, number>();
  for (const side of sides) counts.set(borders[side]!.space, (counts.get(borders[side]!.space) ?? 0) + 1);
  const space = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  const tokens = [sides.length === 4 ? ".box" : `border="${sides.join(" ")}"`, `border-width=${first.width}`, `border-space=${space}`];
  for (const side of sides) if (borders[side]!.space !== space) tokens.push(`border-space-${side}=${borders[side]!.space}`);
  if (first.color) tokens.push(`border-color=${first.color}`);
  if (first.style !== "solid") tokens.push(`border-style=${first.style}`);
  return tokens;
}

/** The style marks every piece of a block's text has (written once, in its {…}). */
function sharedStyle(node: PMNode): Mark[] {
  let shared: readonly Mark[] | null = null;
  node.forEach((child) => {
    if (!child.isText || !child.text?.trim() || child.marks.some((mark) => mark.type.name === "math" || mark.type.name === "code")) return;
    const own = child.marks.filter((mark) => STYLE_MARKS.has(mark.type.name) && mark.type.name !== "font_size");
    shared = shared === null ? own : shared.filter((mark) => own.some((item) => item.eq(mark)));
  });
  return [...((shared as readonly Mark[] | null) ?? [])];
}

function styleTokens(marks: Mark[]): string[] {
  const tokens: string[] = [];
  for (const mark of marks) {
    if (mark.type.name === "text_color") tokens.push(`color=${mark.attrs.color}`);
    else if (mark.type.name === "font_family") tokens.push(`font="${familyNames(String(mark.attrs.family))}"`);
    else if (mark.type.name === "highlight") tokens.push(`highlight=${mark.attrs.color}`);
  }
  return tokens;
}

/** "\"Menlo (notes)\", serif" as the names a font= or font-family gives (the fallback that was added comes back by itself). */
function familyNames(family: string) {
  const names = family.split(",").map((name) => name.replace(/["']/g, "").trim()).filter(Boolean);
  if (names.length === 2 && names[1] === "serif") names.pop();
  return names.join(", ");
}

function spanStyle(marks: readonly Mark[]) {
  const parts: string[] = [];
  for (const mark of marks) {
    if (mark.type.name === "text_color") parts.push(`color: ${mark.attrs.color}`);
    else if (mark.type.name === "font_family") parts.push(`font-family: ${quoteFamilies(familyNames(String(mark.attrs.family)))}`);
    else if (mark.type.name === "font_size") parts.push(`font-size: ${mark.attrs.size}`);
    else if (mark.type.name === "highlight") parts.push(`background-color: ${mark.attrs.color}`);
  }
  return parts.join("; ");
}

function quoteFamilies(names: string) {
  return names
    .split(",")
    .map((name) => name.trim())
    .map((name) => (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(name) ? name : `'${name}'`))
    .join(", ");
}

/**
 * A textblock's content with its styles: runs that share style marks (beyond
 * the block's own) go in one <span style>, pictures in a line as sized <img>.
 */
function layoutInline(node: PMNode, shared: Mark[], atLineStart: boolean): string {
  const keyOf = (marks: readonly Mark[]) =>
    marks
      .filter((mark) => STYLE_MARKS.has(mark.type.name) && !shared.some((item) => item.eq(mark)))
      .map((mark) => `${mark.type.name}:${JSON.stringify(mark.attrs)}`)
      .sort()
      .join("|");
  type Group = { key: string; marks: readonly Mark[]; nodes: PMNode[] } | { image: PMNode };
  const groups: Group[] = [];
  node.forEach((child) => {
    if (child.type.name === "inline_image") {
      groups.push({ image: child });
      return;
    }
    // Equations take no styles: they join the run they're in.
    const math = child.isText && child.marks.some((mark) => mark.type.name === "math");
    const last = groups[groups.length - 1];
    const key = math && last && "key" in last ? last.key : keyOf(child.marks);
    if (last && "key" in last && last.key === key) last.nodes.push(child);
    else groups.push({ key, marks: child.marks, nodes: [child] });
  });
  let out = "";
  for (const group of groups) {
    if ("image" in group) {
      const { src, alt, width, height } = group.image.attrs;
      out += `<img src="${String(src)}"${width ? ` width="${width}"` : ""}${height ? ` height="${height}"` : ""}${alt ? ` alt="${String(alt).replace(/"/g, "&quot;")}"` : ""}>`;
      continue;
    }
    // Markdown's own marks (bold, italic, links…) written as usual, the style marks taken off.
    const nodes = group.nodes.map((child) => (child.isText ? schema.text(child.text ?? "", child.marks.filter((mark) => !STYLE_MARKS.has(mark.type.name))) : child));
    const piece = serializeInline(schema.nodes.paragraph!.create(null, nodes), { atLineStart: atLineStart && !out });
    const style = spanStyle(group.marks.filter((mark) => STYLE_MARKS.has(mark.type.name) && !shared.some((item) => item.eq(mark))));
    out += style ? `<span style="${style}">${piece}</span>` : piece;
  }
  return out;
}

import postcss from "postcss";
import type { RGB } from "@/lib/pdf/pdfWriter";
import { darkColor } from "@/lib/pdf/thumbnail";

/** Canvas CSS is data, never a document-wide stylesheet. */
const PROPERTIES = new Set(`color background-color font-family font-size font-weight font-style line-height letter-spacing text-align text-transform text-decoration text-decoration-color text-underline-offset margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left border border-top border-right border-bottom border-left border-color border-width border-style border-radius gap column-gap row-gap width max-width min-width vertical-align list-style-type`.split(" "));
const TAGS: Record<string, string> = { Canvas: "[data-canvas-root]", Section: '[data-canvas="section"]', Stack: '[data-canvas="stack"]', Columns: '[data-canvas="columns"]', Column: '[data-canvas="column"]', Figure: '[data-canvas="figure"]', Text: ":is(p,h1,h2,h3,h4,h5,h6)", RichText: '[data-canvas="richtext"]', Table: "table" };
const SELECTOR = /^(?:[A-Za-z][A-Za-z0-9-]*|\.[A-Za-z_][\w-]*)(?:(?:\s+|\s*>\s*)(?:[A-Za-z][A-Za-z0-9-]*|\.[A-Za-z_][\w-]*)|\.[A-Za-z_][\w-]*)*$/;

export function validateCanvasClass(value: string) {
  if (!/^[A-Za-z_][\w-]*(?:\s+[A-Za-z_][\w-]*)*$/.test(value)) throw new Error("Invalid Canvas class.");
  for (const name of value.split(/\s+/)) if (/^(?:page-|doc-|image-|picture-|review-|agent-|ProseMirror|math-|katex|table-|canvas-|format-selection|find-match|spelling-error|comment-hl|selectedCell|column-resize-handle|np-)/i.test(name)) throw new Error(`Class ${name} is reserved for Inline's editor. Choose an authored class name.`);
}

export function validateCanvasCss(css: string): string {
  if (css.length > 80_000) throw new Error("Canvas CSS exceeds 80,000 characters.");
  const root = postcss.parse(css);
  root.walkAtRules((rule) => { throw rule.error("Canvas CSS does not support at-rules. Fonts use Inline's font picker; paper settings use Canvas settings."); });
  root.walkRules((rule) => {
    if (rule.parent !== root) throw rule.error("Nested CSS is unsupported. Write a separate selector.");
    for (const selector of rule.selectors) {
      if (!SELECTOR.test(selector.trim())) throw rule.error(`Unsupported selector ${selector}. Use component names, HTML tags, classes, descendants, or child selectors.`);
      for (const match of selector.matchAll(/\.([A-Za-z_][\w-]*)/g)) validateCanvasClass(match[1]);
      if (selector.split(/[\s>.]+/).some((part) => ["html", "body", "script", "style", "iframe"].includes(part.toLowerCase()))) throw rule.error("Canvas selectors cannot target the application.");
    }
  });
  root.walkDecls((decl) => {
    if (decl.parent?.type !== "rule" || !PROPERTIES.has(decl.prop.toLowerCase())) throw decl.error(`Unsupported Canvas CSS property ${decl.prop}. Layout comes from Stack/Columns; fixed positioning, height, clipping, and scripts are unsupported.`);
    if (decl.important || /[\\<>@]|url\s*\(|expression\s*\(|var\s*\(|attr\s*\(|(?:javascript|data):/i.test(decl.value)) throw decl.error(`Unsupported value for ${decl.prop}. Use literal colors, lengths, and font names.`);
    if (/^-/.test(decl.value.trim()) && /margin|padding|width|gap/.test(decl.prop)) throw decl.error("Negative layout lengths are unsupported.");
  });
  root.walkComments((comment) => { comment.remove(); });
  return root.toString();
}

const COLOR_VALUE = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|rgba?\([^)]*\)/g;
const COLOR_PROPS = /^(?:color|background-color|border-color|text-decoration-color|border|border-top|border-right|border-bottom|border-left)$/;

function parseColorToken(token: string): RGB | null {
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(token);
  if (hex) {
    const raw = hex[1].length <= 4 ? [...hex[1].slice(0, 3)].map((channel) => channel + channel).join("") : hex[1];
    return [parseInt(raw.slice(0, 2), 16) / 255, parseInt(raw.slice(2, 4), 16) / 255, parseInt(raw.slice(4, 6), 16) / 255];
  }
  const rgb = /^rgba?\(\s*([\d.]+)(%?)[,\s]+([\d.]+)(%?)[,\s]+([\d.]+)(%?)/i.exec(token);
  if (!rgb) return null;
  const channel = (value: string, percent: string) => (percent ? Number(value) / 100 : Number(value) / 255);
  return [channel(rgb[1], rgb[2]), channel(rgb[3], rgb[4]), channel(rgb[5], rgb[6])];
}

function flipColorTokens(value: string) {
  return value.replace(COLOR_VALUE, (token) => {
    const rgb = parseColorToken(token);
    if (!rgb) return token;
    const [r, g, b] = darkColor(rgb);
    return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
  });
}

/**
 * The same rules with lightness flipped the way the dark thumbnail flips painted
 * colors. Wrapped in `@media screen` so print and PDF keep the light rules.
 */
export function darkScreenCanvasCss(scoped: string): string {
  const root = postcss.parse(scoped);
  root.walkDecls((decl) => {
    if (COLOR_PROPS.test(decl.prop)) decl.value = flipColorTokens(decl.value);
  });
  return `@media screen {\n${root.toString()}\n}`;
}

/** Prefix every rule, including selectors targeting the Canvas itself. */
export function scopedCanvasCss(css: string, id: string): string {
  const root = postcss.parse(validateCanvasCss(css));
  // `.doc-content` keeps authored rules ahead of the ordinary heading stylesheet.
  const scope = `.doc-content[data-canvas-root="${id.replace(/[^a-zA-Z0-9_-]/g, "")}"]`;
  root.walkRules((rule) => {
    rule.selectors = rule.selectors.map((selector) => {
      let converted = selector.replace(/(^|[\s>])(Canvas|Section|Stack|Columns|Column|Figure|Text|RichText|Table)(?=[.\s>]|$)/g, (_match, prefix, tag) => prefix + TAGS[tag]);
      if (converted.startsWith("[data-canvas-root]")) return converted.replace("[data-canvas-root]", scope);
      return `${scope} ${converted}`;
    });
  });
  return root.toString();
}

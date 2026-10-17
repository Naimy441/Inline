import postcss from "postcss";

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

/** Prefix every rule, including selectors targeting the Canvas itself. */
export function scopedCanvasCss(css: string, id: string): string {
  const root = postcss.parse(validateCanvasCss(css));
  const scope = `[data-canvas-root="${id.replace(/[^a-zA-Z0-9_-]/g, "")}"]`;
  root.walkRules((rule) => {
    rule.selectors = rule.selectors.map((selector) => {
      let converted = selector.replace(/(^|[\s>])(Canvas|Section|Stack|Columns|Column|Figure|Text|RichText|Table)(?=[.\s>]|$)/g, (_match, prefix, tag) => prefix + TAGS[tag]);
      if (converted.startsWith("[data-canvas-root]")) return converted.replace("[data-canvas-root]", scope);
      return `${scope} ${converted}`;
    });
  });
  return root.toString();
}

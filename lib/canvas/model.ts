import type { Node as PMNode } from "prosemirror-model";
import { validateCanvasCss, validateCanvasClass } from "./styles";
import postcss from "postcss";

/** Match the SDK's deliberately small selector vocabulary against model nodes. */
function selectorMatches(selector: string, path: PMNode[]): boolean {
  const parts = selector.trim().replace(/\s*>\s*/g, " > ").split(/\s+/);
  const matches = (token: string, node: PMNode) => {
    const [tag, ...classes] = token.split(".");
    if (classes.some((c) => !String(node.attrs.canvasClass || "").split(/\s+/).includes(c))) return false;
    if (!tag) return true;
    const names: Record<string, string> = { doc: "Canvas", canvas_section: "Section", canvas_stack: "Stack", canvas_richtext: "RichText", canvas_columns: "Columns", canvas_column: "Column", canvas_figure: "Figure", paragraph: "p", heading: `h${node.attrs.level}`, table: "table", table_row: "tr", table_cell: "td", table_header: "th" };
    return tag === names[node.type.name] || (tag === "Text" && node.isTextblock) || (tag === "Table" && node.type.name === "table");
  };
  let position = path.length - 1;
  if (!matches(parts.pop()!, path[position])) return false;
  while (parts.length) {
    const direct = parts.at(-1) === ">";
    if (direct) parts.pop();
    const token = parts.pop()!;
    position--;
    if (!direct) while (position >= 0 && !matches(token, path[position])) position--;
    if (position < 0 || !matches(token, path[position])) return false;
  }
  return true;
}

export function validateCanvasDecorations(doc: PMNode) {
  const root = postcss.parse(doc.attrs.canvas.css);
  const flowing: PMNode[][] = [];
  const walk = (node: PMNode, parents: PMNode[]) => {
    const path = [...parents, node];
    if (node.type.name.startsWith("canvas_") && node.attrs.pagination === "flow" && !parents.some((p) => p.attrs.pagination === "keep-together")) flowing.push(path);
    node.forEach((child) => walk(child, path));
  };
  walk(doc, []);
  root.walkRules((rule) => {
    if (!flowing.some((path) => rule.selectors.some((s) => selectorMatches(s, path)))) return;
    rule.walkDecls((decl) => {
      const painted = (decl.prop === "background-color" && decl.value !== "transparent") || (decl.prop === "background" && decl.value.trim() !== "transparent");
      if ((/^padding|^border/.test(decl.prop) && !/^(0(?:px|pt|em|rem)?|none)$/.test(decl.value.trim())) || painted) throw decl.error("Flowing containers must be transparent and have no padding or border. Use pagination=\"keep-together\" or decorate individual paragraphs.");
    });
  });
}

/** Validate at the authority boundary as well as at the authoring importer. */
export function validateCanvasDocument(doc: PMNode) {
  const design = doc.attrs.canvas;
  if (design == null) {
    let hasCanvas = false;
    doc.descendants((node) => { if (node.type.name.startsWith("canvas_")) hasCanvas = true; });
    if (hasCanvas) throw new Error("Canvas components require a Canvas document.");
    return;
  }
  if (design.format !== 1 || typeof design.css !== "string") throw new Error("Unsupported Canvas format.");
  validateCanvasCss(design.css);
  validateCanvasDecorations(doc);
  let nodes = 0;
  doc.descendants((node) => {
    if (++nodes > 10_000) throw new Error("Canvas exceeds 10,000 nodes.");
    if (node.attrs.canvasClass && !/^[A-Za-z_][\w-]*(?:\s+[A-Za-z_][\w-]*)*$/.test(node.attrs.canvasClass)) throw new Error("Invalid Canvas class.");
    if (node.attrs.canvasClass) validateCanvasClass(node.attrs.canvasClass);
    for (const mark of node.marks) if (mark.type.name === "canvas_span") validateCanvasClass(mark.attrs.class);
    if (node.type.name.startsWith("canvas_")) {
      if (!["flow", "keep-together"].includes(node.attrs.pagination)) throw new Error("Invalid Canvas pagination policy.");
      if (["canvas_columns", "canvas_figure"].includes(node.type.name) && node.attrs.pagination !== "keep-together") throw new Error("Columns and figures must stay together.");
      if (node.attrs.bleed && (node.type.name !== "canvas_section" || node.attrs.pagination !== "keep-together")) throw new Error("bleed is only supported on a keep-together Section.");
      if (node.type.name === "canvas_columns" && node.attrs.ratio && (!/^[1-4]:[1-4](?::[1-4])?$/.test(node.attrs.ratio) || node.attrs.ratio.split(":").length !== node.childCount)) throw new Error("Invalid Columns ratio.");
    }
  });
  doc.check();
}

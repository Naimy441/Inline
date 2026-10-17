import type { Node as PMNode } from "prosemirror-model";
import { TextSelection, type Command, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { Plugin, PluginKey } from "prosemirror-state";
import {
  CellSelection,
  TableMap,
  TableView,
  findTable,
  isInTable,
  mergeCells,
  selectionCell,
  splitCell,
} from "prosemirror-tables";
import {
  normalizeFormula,
  schema,
  tableLineCss,
  type CellBorders,
  type RowHeightRule,
  type TableBorders,
  type TableLine,
} from "@/lib/doc/schema";

/**
 * Table editing Word puts on the Table menu: merge and split, borders and
 * shading, column widths and row heights, a SUM formula, and text turned
 * into a table or back. Merged cells, shading and header rows were already
 * stored; these commands create and change them.
 */

const NIL: TableLine = { style: "nil", width: 0, color: null };
const RULE: TableLine = { style: "solid", width: 1, color: "#000000" };
const PX_PER_PT = 96 / 72;

export const mergeTableCells = mergeCells;

type TableCtx = { state: EditorState; $cell: ReturnType<typeof selectionCell>; cell: PMNode; table: NonNullable<ReturnType<typeof findTable>> };

function context(state: EditorState): TableCtx | null {
  if (!isInTable(state)) return null;
  let $cell: ReturnType<typeof selectionCell>;
  try {
    $cell = selectionCell(state);
  } catch {
    return null;
  }
  const cell = $cell.nodeAfter;
  const table = findTable($cell);
  if (!cell || !table) return null;
  return { state, $cell, cell, table };
}

/** Split a merged cell back into the cells it was made of, or a plain cell into two. */
export const splitTableCell: Command = (state, dispatch) => {
  const ctx = context(state);
  if (!ctx) return false;
  if (ctx.cell.attrs.colspan > 1 || ctx.cell.attrs.rowspan > 1) return splitCell(state, dispatch);
  return splitPlainCell(state, dispatch, ctx);
};

/**
 * Divide one unmerged cell into two. Every other cell in that column spans
 * both, so the grid stays rectangular and only this cell gains a neighbour.
 */
function splitPlainCell(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, ctx: TableCtx) {
  const map = TableMap.get(ctx.table.node);
  const rel = ctx.$cell.pos - ctx.table.start;
  const rect = map.findCell(rel);
  const seen = new Set<number>();
  for (let row = 0; row < map.height; row += 1) {
    const pos = map.map[row * map.width + rect.left]!;
    if (seen.has(pos)) continue;
    seen.add(pos);
    const covered = map.findCell(pos);
    if (covered.left !== rect.left || covered.right !== rect.left + 1) return false;
  }
  if (!dispatch) return true;
  const tr = state.tr;
  const targets = [...seen].sort((a, b) => b - a);
  for (const pos of targets) {
    const abs = tr.mapping.map(ctx.table.start + pos);
    const node = tr.doc.nodeAt(abs);
    if (!node) continue;
    if (pos === rel) {
      const fresh = node.type.createAndFill({ colspan: 1, rowspan: node.attrs.rowspan })!;
      tr.insert(abs + node.nodeSize, fresh);
    } else {
      const colwidth = node.attrs.colwidth as number[] | null;
      tr.setNodeMarkup(abs, undefined, {
        ...node.attrs,
        colspan: node.attrs.colspan + 1,
        colwidth: colwidth ? [...colwidth, colwidth[colwidth.length - 1] ?? 0] : null,
      });
    }
  }
  dispatch(tr.scrollIntoView());
  return true;
}

/** Break the table above the current row. The two tables keep the borders and widths. */
export const splitTable: Command = (state, dispatch) => {
  const ctx = context(state);
  if (!ctx) return false;
  const rowIndex = ctx.$cell.index(-1);
  if (rowIndex <= 0) return false;
  const table = ctx.table.node;
  const top: PMNode[] = [];
  const bottom: PMNode[] = [];
  table.forEach((row, _offset, index) => (index < rowIndex ? top : bottom).push(row));
  if (!top.length || !bottom.length) return false;
  if (!dispatch) return true;
  const topTable = schema.nodes.table!.create(table.attrs, top);
  const bottomTable = schema.nodes.table!.create({ ...table.attrs, id: null }, bottom);
  const between = schema.nodes.paragraph!.create();
  const tr = state.tr.replaceWith(ctx.table.pos, ctx.table.pos + table.nodeSize, [topTable, between, bottomTable]);
  const bottomStart = ctx.table.pos + topTable.nodeSize + between.nodeSize;
  tr.setSelection(TextSelection.near(tr.doc.resolve(bottomStart + 1)));
  dispatch(tr.scrollIntoView());
  return true;
};

function borderPreset(preset: "all" | "outside" | "inside" | "none", line: TableLine = RULE): TableBorders {
  if (preset === "none") return { top: NIL, left: NIL, bottom: NIL, right: NIL, insideH: NIL, insideV: NIL };
  if (preset === "outside") return { top: line, left: line, bottom: line, right: line, insideH: NIL, insideV: NIL };
  if (preset === "inside") return { top: NIL, left: NIL, bottom: NIL, right: NIL, insideH: line, insideV: line };
  return { top: line, left: line, bottom: line, right: line, insideH: line, insideV: line };
}

/** Table borders (Word's outside and inside edges), not a single cell's background. */
export function setTableBorders(preset: "all" | "outside" | "inside" | "none", line?: TableLine): Command {
  return (state, dispatch) => {
    const ctx = context(state);
    if (!ctx) return false;
    if (!dispatch) return true;
    dispatch(state.tr.setNodeMarkup(ctx.table.pos, undefined, { ...ctx.table.node.attrs, borders: borderPreset(preset, line) }));
    return true;
  };
}

/** Shading behind the selected cells. Null clears it. */
export function setCellShading(color: string | null): Command {
  return (state, dispatch) => {
    const ctx = context(state);
    if (!ctx) return false;
    const paint = (node: PMNode, pos: number, tr: Transaction) => {
      if (node.attrs.background === color) return;
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, background: color });
    };
    if (!dispatch) return true;
    const tr = state.tr;
    if (state.selection instanceof CellSelection) state.selection.forEachCell((node, pos) => paint(node, pos, tr));
    else paint(ctx.cell, ctx.$cell.pos, tr);
    if (!tr.docChanged) return false;
    dispatch(tr);
    return true;
  };
}

function columnWidths(table: PMNode, map: TableMap): number[] {
  const widths = Array.from({ length: map.width }, () => 0);
  const seen = new Set<number>();
  for (const rel of map.map) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const cell = table.nodeAt(rel);
    const cols = cell?.attrs.colwidth as number[] | null;
    if (!cell || !cols) continue;
    const rect = map.findCell(rel);
    cols.forEach((width, index) => {
      if (width > 0) widths[rect.left + index] = width;
    });
  }
  return widths;
}

function writeColumnWidths(tr: Transaction, tablePos: number, table: PMNode, widths: number[]) {
  const map = TableMap.get(table);
  const start = tablePos + 1;
  const seen = new Set<number>();
  for (const rel of map.map) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const cell = table.nodeAt(rel);
    if (!cell) continue;
    const rect = map.findCell(rel);
    const next = Array.from({ length: rect.right - rect.left }, (_, index) => widths[rect.left + index] ?? 0);
    const prev = cell.attrs.colwidth as number[] | null;
    if (prev && prev.length === next.length && prev.every((width, index) => width === next[index])) continue;
    tr.setNodeMarkup(start + rel, undefined, { ...cell.attrs, colwidth: next });
  }
}

/** Set the width of the column the cursor is in, in points. */
export function setColumnWidth(points: number): Command {
  return (state, dispatch) => {
    const ctx = context(state);
    if (!ctx || !Number.isFinite(points) || points <= 0) return false;
    const map = TableMap.get(ctx.table.node);
    const rel = ctx.$cell.pos - ctx.table.start;
    const col = map.findCell(rel).left;
    const widths = columnWidths(ctx.table.node, map);
    widths[col] = Math.max(25, Math.round(points * PX_PER_PT));
    if (!dispatch) return true;
    const tr = state.tr;
    writeColumnWidths(tr, ctx.table.pos, ctx.table.node, widths);
    dispatch(tr);
    return true;
  };
}

function tableElement(view: EditorView, pos: number): HTMLTableElement | null {
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) return null;
  if (dom instanceof HTMLTableElement) return dom;
  return dom.querySelector("table");
}

/** Give every column the same width, the table's width shared out. */
export const distributeColumns: Command = (state, dispatch, view) => {
  const ctx = context(state);
  if (!ctx) return false;
  const map = TableMap.get(ctx.table.node);
  const dom = view ? tableElement(view, ctx.table.pos) : null;
  const total = dom?.offsetWidth || columnWidths(ctx.table.node, map).reduce((sum, width) => sum + width, 0) || map.width * 100;
  const each = Math.max(25, Math.round(total / map.width));
  if (!dispatch) return true;
  const tr = state.tr;
  writeColumnWidths(tr, ctx.table.pos, ctx.table.node, Array.from({ length: map.width }, () => each));
  dispatch(tr);
  return true;
};

function rowAt(state: EditorState): { tablePos: number; rowPos: number; row: PMNode } | null {
  const ctx = context(state);
  if (!ctx) return null;
  const rowPos = ctx.$cell.before();
  const row = state.doc.nodeAt(rowPos);
  if (!row || row.type.spec.tableRole !== "row") return null;
  return { tablePos: ctx.table.pos, rowPos, row };
}

/** Set the current row's height in points. `exact` clips; `atLeast` is a minimum. */
export function setRowHeight(points: number, rule: RowHeightRule = "atLeast"): Command {
  return (state, dispatch) => {
    const found = rowAt(state);
    if (!found || !Number.isFinite(points) || points <= 0) return false;
    if (!dispatch) return true;
    const height = Math.round(points * 100) / 100;
    dispatch(state.tr.setNodeMarkup(found.rowPos, undefined, { ...found.row.attrs, height, heightRule: rule }));
    return true;
  };
}

/** Make every row as tall as the tallest, so a short row grows to match. */
export const distributeRows: Command = (state, dispatch, view) => {
  const ctx = context(state);
  if (!ctx) return false;
  const table = ctx.table.node;
  const heights: number[] = [];
  table.forEach((row, offset) => {
    const dom = view?.nodeDOM(ctx.table.pos + 1 + offset);
    const px = typeof HTMLElement !== "undefined" && dom instanceof HTMLElement ? dom.offsetHeight : 0;
    const stored = Number(row.attrs.height) * PX_PER_PT;
    heights.push(px || stored || 0);
  });
  const tallest = Math.max(...heights);
  if (!tallest) return false;
  const points = Math.round((tallest / PX_PER_PT) * 100) / 100;
  if (!dispatch) return true;
  const tr = state.tr;
  table.forEach((row, offset) => {
    tr.setNodeMarkup(ctx.table.pos + 1 + offset, undefined, { ...row.attrs, height: points, heightRule: row.attrs.heightRule === "exact" ? "exact" : "atLeast" });
  });
  dispatch(tr);
  return true;
};

// --- formulas ----------------------------------------------------------------

const COLS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function columnIndex(label: string): number {
  let index = 0;
  for (const char of label) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function parseRef(ref: string): { col: number; row: number } | null {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) return null;
  return { col: columnIndex(match[1]!), row: Number(match[2]) - 1 };
}

function cellNumber(text: string): number | null {
  const match = /[-+]?(?:\d+\.?\d*|\.\d+)/.exec(text.replace(/,/g, ""));
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

export function formatSum(value: number): string {
  if (!Number.isFinite(value)) return "";
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}

/**
 * The text each formula cell should show. A cell is counted once even when a
 * merge makes it cover several addresses. Formulas may refer to other formulas.
 */
export function formulaResults(table: PMNode): Map<number, string> {
  let map: TableMap;
  try {
    map = TableMap.get(table);
  } catch {
    return new Map();
  }
  const formulas = new Map<number, string>();
  const seen = new Set<number>();
  for (const rel of map.map) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const cell = table.nodeAt(rel);
    const formula = typeof cell?.attrs.formula === "string" ? normalizeFormula(cell.attrs.formula) : null;
    if (formula) formulas.set(rel, formula);
  }
  const numbers = new Map<number, number | null>();
  seen.clear();
  for (const rel of map.map) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (formulas.has(rel)) continue;
    numbers.set(rel, cellNumber(table.nodeAt(rel)?.textContent ?? ""));
  }
  const results = new Map<number, string>();
  const pending = new Map(formulas);
  for (let pass = 0; pass < 8 && pending.size; pass += 1) {
    let progressed = false;
    for (const [rel, formula] of [...pending]) {
      const value = sumFormula(map, rel, formula, numbers);
      if (value == null) continue;
      numbers.set(rel, value);
      results.set(rel, formatSum(value));
      pending.delete(rel);
      progressed = true;
    }
    if (!progressed) break;
  }
  return results;
}

function sumFormula(map: TableMap, rel: number, formula: string, numbers: Map<number, number | null>): number | null {
  const arg = /^SUM\((.*)\)$/.exec(formula)?.[1];
  if (!arg) return null;
  const rect = map.findCell(rel);
  let cells: number[] = [];
  if (arg === "ABOVE" || arg === "BELOW" || arg === "LEFT" || arg === "RIGHT") {
    const rows = arg === "ABOVE" ? [0, rect.top - 1] : arg === "BELOW" ? [rect.bottom, map.height - 1] : [rect.top, rect.bottom - 1];
    const cols = arg === "LEFT" ? [0, rect.left - 1] : arg === "RIGHT" ? [rect.right, map.width - 1] : [rect.left, rect.right - 1];
    cells = cellsIn(map, cols[0]!, cols[1]!, rows[0]!, rows[1]!);
  } else if (arg.includes(":")) {
    const [start, end] = arg.split(":");
    const a = parseRef(start!);
    const b = parseRef(end!);
    if (!a || !b) return null;
    cells = cellsIn(map, Math.min(a.col, b.col), Math.max(a.col, b.col), Math.min(a.row, b.row), Math.max(a.row, b.row));
  } else {
    const one = parseRef(arg);
    if (!one) return null;
    cells = cellsIn(map, one.col, one.col, one.row, one.row);
  }
  if (cells.some((pos) => !numbers.has(pos) && pos !== rel)) return null;
  let total = 0;
  for (const pos of cells) {
    if (pos === rel) continue;
    const value = numbers.get(pos);
    if (value != null) total += value;
  }
  return total;
}

function cellsIn(map: TableMap, left: number, right: number, top: number, bottom: number) {
  const found = new Set<number>();
  for (let row = top; row <= bottom; row += 1) {
    for (let col = left; col <= right; col += 1) {
      if (row < 0 || col < 0 || row >= map.height || col >= map.width) continue;
      found.add(map.map[row * map.width + col]!);
    }
  }
  return [...found];
}

function resultParagraph(text: string) {
  return schema.nodes.paragraph!.create(null, text ? schema.text(text) : undefined);
}

/** Store a SUM formula on the current cell and show its result. Null clears it. */
export function setCellFormula(formula: string | null): Command {
  return (state, dispatch) => {
    const ctx = context(state);
    if (!ctx) return false;
    const normalized = formula == null || formula.trim() === "" ? null : normalizeFormula(formula);
    if (formula && !normalized) return false;
    if (!dispatch) return true;
    const tr = state.tr.setNodeMarkup(ctx.$cell.pos, undefined, { ...ctx.cell.attrs, formula: normalized });
    const table = tr.doc.nodeAt(ctx.table.pos);
    const cell = tr.doc.nodeAt(ctx.$cell.pos);
    if (table && cell && normalized) {
      const text = formulaResults(table).get(ctx.$cell.pos - ctx.table.start) ?? "";
      if (cell.textContent !== text) tr.replaceWith(ctx.$cell.pos + 1, ctx.$cell.pos + cell.nodeSize - 1, resultParagraph(text));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Keep formula cells showing the sum as the numbers around them change. */
export function tableFormulaPlugin() {
  return new Plugin({
    appendTransaction(transactions, _old, state) {
      if (!transactions.some((tr) => tr.docChanged)) return null;
      const fixes: Array<{ pos: number; size: number; text: string }> = [];
      state.doc.descendants((node, pos) => {
        if (node.type.name !== "table") return;
        const results = formulaResults(node);
        if (!results.size) return;
        const { from, to } = state.selection;
        node.forEach((row, rowOffset) => {
          row.forEach((cell, cellOffset) => {
            const offset = rowOffset + 1 + cellOffset;
            const text = results.get(offset);
            if (text == null || cell.textContent === text) return;
            const cellPos = pos + 1 + offset;
            if (from > cellPos && to < cellPos + cell.nodeSize) return;
            fixes.push({ pos: cellPos, size: cell.nodeSize, text });
          });
        });
      });
      if (!fixes.length) return null;
      const tr = state.tr;
      for (let i = fixes.length - 1; i >= 0; i -= 1) {
        const fix = fixes[i]!;
        tr.replaceWith(fix.pos + 1, fix.pos + fix.size - 1, resultParagraph(fix.text));
      }
      return tr;
    },
  });
}

// --- borders drawn on the cells ------------------------------------------------

const borderKey = new PluginKey<DecorationSet>("tableBorders");

function resolvedEdge(own: TableLine | undefined, edge: TableLine | undefined, inside: TableLine | undefined, atEdge: boolean): TableLine | undefined {
  return own ?? (atEdge ? edge : inside);
}

function borderDecorations(doc: PMNode) {
  const decorations: Decoration[] = [];
  doc.descendants((table, pos) => {
    if (table.type.name !== "table") return;
    const borders = table.attrs.borders as TableBorders | null;
    if (!borders) return false;
    let map: TableMap;
    try {
      map = TableMap.get(table);
    } catch {
      return false;
    }
    table.forEach((row, rowOffset) => {
      row.forEach((cell, cellOffset) => {
        const cellPos = pos + 1 + rowOffset + 1 + cellOffset;
        const rect = map.findCell(cellPos - pos - 1);
        const own = cell.attrs.borders as CellBorders | null;
        const edges = {
          top: resolvedEdge(own?.top, borders.top, borders.insideH, rect.top === 0),
          right: resolvedEdge(own?.right, borders.right, borders.insideV, rect.right === map.width),
          bottom: resolvedEdge(own?.bottom, borders.bottom, borders.insideH, rect.bottom === map.height),
          left: resolvedEdge(own?.left, borders.left, borders.insideV, rect.left === 0),
        };
        const parts = (["top", "right", "bottom", "left"] as const).map((side) => `border-${side}: ${tableLineCss(edges[side])}`);
        if (cell.attrs.background) parts.push(`background-color: ${cell.attrs.background}`);
        decorations.push(Decoration.node(cellPos, cellPos + cell.nodeSize, { style: parts.join("; ") }));
      });
    });
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/** Paint table borders on the cells. A cell's own edges win over the table's. */
export function tableBorderPlugin() {
  return new Plugin({
    key: borderKey,
    state: {
      init: (_config, state) => borderDecorations(state.doc),
      apply: (tr, value) => (tr.docChanged ? borderDecorations(tr.doc) : value),
    },
    props: { decorations: (state) => borderKey.getState(state) },
  });
}

/** The column-resize node view also carries the table's id and borders, which its own DOM omits. */
export class InlineTableView extends TableView {
  constructor(node: PMNode, cellMinWidth: number, _view?: EditorView) {
    super(node, cellMinWidth);
    syncTableDom(this.table, node);
  }

  update(node: PMNode) {
    const ok = super.update(node);
    if (ok) syncTableDom(this.table, node);
    return ok;
  }
}

function syncTableDom(table: HTMLTableElement, node: PMNode) {
  for (const name of (table.dataset.canvasClass || "").split(/\s+/).filter(Boolean)) table.classList.remove(name);
  if (node.attrs.canvasClass) {
    table.dataset.canvasClass = node.attrs.canvasClass;
    for (const name of node.attrs.canvasClass.split(/\s+/)) table.classList.add(name);
  } else table.removeAttribute("data-canvas-class");
  if (node.attrs.id) table.setAttribute("data-id", String(node.attrs.id));
  else table.removeAttribute("data-id");
  if (node.attrs.borders) table.setAttribute("data-borders", JSON.stringify(node.attrs.borders));
  else table.removeAttribute("data-borders");
}

// --- text to a table and back --------------------------------------------------

/** Selected paragraphs become rows. Tabs, or else commas, split a row into cells. */
export const textToTable: Command = (state, dispatch) => {
  if (isInTable(state)) return false;
  const { from, to } = state.selection;
  const blocks: Array<{ node: PMNode; pos: number }> = [];
  state.doc.forEach((node, offset) => {
    const end = offset + node.nodeSize;
    if (end <= from || offset >= to) return;
    if (!node.isTextblock) return;
    blocks.push({ node, pos: offset });
  });
  if (!blocks.length || blocks.every((block) => !block.node.textContent.trim())) return false;
  const lines = blocks.map((block) => block.node.textContent);
  const delimiter = lines.some((line) => line.includes("\t")) ? "\t" : lines.some((line) => line.includes(",")) ? "," : null;
  const grid = lines.map((line) => (delimiter ? line.split(delimiter).map((part) => part.trim()) : [line]));
  const columns = Math.max(...grid.map((row) => row.length));
  // Cells stay ordinary cells. A header row is a separate choice (Toggle header row).
  const built = grid.map((row) =>
    schema.nodes.table_row!.create(
      null,
      Array.from({ length: columns }, (_, column) => {
        const text = row[column] ?? "";
        return schema.nodes.table_cell!.create(null, schema.nodes.paragraph!.create(null, text ? schema.text(text) : undefined));
      }),
    ),
  );
  if (!dispatch) return true;
  const start = blocks[0]!.pos;
  const end = blocks[blocks.length - 1]!.pos + blocks[blocks.length - 1]!.node.nodeSize;
  const table = schema.nodes.table!.create(null, built);
  const tr = state.tr.replaceWith(start, end, table);
  tr.setSelection(TextSelection.near(tr.doc.resolve(start + 2)));
  dispatch(tr.scrollIntoView());
  return true;
};

/** The table becomes paragraphs, one per row, cells separated by tabs. */
export const tableToText: Command = (state, dispatch) => {
  const ctx = context(state);
  if (!ctx) return false;
  const paragraphs: PMNode[] = [];
  ctx.table.node.forEach((row) => {
    const parts: string[] = [];
    row.forEach((cell) => parts.push(cell.textContent.replace(/\s+/g, " ").trim()));
    const text = parts.join("\t");
    paragraphs.push(schema.nodes.paragraph!.create(null, text ? schema.text(text) : undefined));
  });
  if (!paragraphs.length) return false;
  if (!dispatch) return true;
  const tr = state.tr.replaceWith(ctx.table.pos, ctx.table.pos + ctx.table.node.nodeSize, paragraphs);
  tr.setSelection(TextSelection.near(tr.doc.resolve(ctx.table.pos + 1)));
  dispatch(tr.scrollIntoView());
  return true;
};

/** How many leading rows are header rows (every cell a header). */
export function headerRowCount(table: PMNode) {
  let count = 0;
  for (let i = 0; i < table.childCount; i += 1) {
    const row = table.child(i);
    if (!row.childCount || !Array.from({ length: row.childCount }, (_, c) => row.child(c)).every((cell) => cell.type.name === "table_header")) break;
    count += 1;
  }
  return count;
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection, type Command } from "prosemirror-state";
import { CellSelection } from "prosemirror-tables";
import { documentToDocx } from "@/lib/doc/docx";
import { docxToDoc } from "@/lib/doc/docxImport";
import { markdownToDoc } from "@/lib/doc/markdown";
import { schema } from "@/lib/doc/schema";
import { DEFAULT_SETTINGS, type DocumentMeta } from "@/lib/doc/settings";
import { readZip } from "@/lib/server/unzip";
import { insertTable } from "./commands";
import {
  distributeColumns,
  distributeRows,
  formulaResults,
  mergeTableCells,
  setCellFormula,
  setCellShading,
  setColumnWidth,
  setRowHeight,
  setTableBorders,
  splitTable,
  splitTableCell,
  tableFormulaPlugin,
  tableToText,
  textToTable,
} from "./tables";

const meta: DocumentMeta = { id: "d1", title: "Plan", createdAt: 0, updatedAt: 0, lastOpenedAt: 0, trashedAt: null, settings: DEFAULT_SETTINGS, wordCount: 0, preview: "" };

function cell(text: string, attrs: Record<string, unknown> | null = null, header = false) {
  const type = header ? schema.nodes.table_header! : schema.nodes.table_cell!;
  return type.create(attrs, schema.nodes.paragraph!.create(null, text ? schema.text(text) : undefined));
}

function grid(rows: string[][], header = true) {
  return schema.nodes.table!.create(
    null,
    rows.map((values, index) =>
      schema.nodes.table_row!.create(
        null,
        values.map((text) => cell(text, null, header && index === 0)),
      ),
    ),
  );
}

function stateFor(doc: PMNode, text?: string) {
  const base = EditorState.create({ doc: schema.nodes.doc!.create(null, doc.type.name === "doc" ? doc.content : [doc]), plugins: [tableFormulaPlugin()] });
  if (!text) return base;
  let pos = 1;
  base.doc.descendants((node, at) => {
    if (node.isText && node.text === text) pos = at + node.text!.length;
  });
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, pos)));
}

function run(state: EditorState, command: Command) {
  let next = state;
  const ok = command(state, (tr) => {
    next = state.apply(tr);
  });
  return { ok, state: next };
}

function cellByText(doc: PMNode, text: string): PMNode {
  const matches: PMNode[] = [];
  doc.descendants((node) => {
    if (matches.length) return false;
    if ((node.type.name === "table_cell" || node.type.name === "table_header") && node.textContent === text) matches.push(node);
    return matches.length === 0;
  });
  const found = matches[0];
  assert.ok(found, text);
  return found;
}

function selectCells(state: EditorState, a: string, b: string) {
  const at = (text: string) => {
    let found = -1;
    state.doc.descendants((node, pos) => {
      if (found < 0 && (node.type.name === "table_cell" || node.type.name === "table_header") && node.textContent === text) found = pos;
      return found < 0;
    });
    assert.ok(found >= 0, text);
    return found;
  };
  return state.apply(state.tr.setSelection(new CellSelection(state.doc.resolve(at(a)), state.doc.resolve(at(b)))));
}

async function throughWord(doc: PMNode) {
  const file = await documentToDocx(schema.nodes.doc!.create(null, [doc]), meta, async () => null);
  const back = await docxToDoc(readZip(file));
  let table = back.firstChild!;
  back.forEach((node) => {
    if (node.type.name === "table") table = node;
  });
  return table;
}

describe("table editing", () => {
  it("inserts a table, and merge then split keeps the cells", () => {
    const inserted = run(stateFor(schema.nodes.paragraph!.create(null, schema.text("Hello")), "Hello"), insertTable(2, 2));
    assert.equal(inserted.ok, true);
    let table = inserted.state.doc.child(1);
    assert.equal(table.type.name, "table");
    assert.equal(table.child(0).child(0).type.name, "table_header");
    const withText = inserted.state.apply(inserted.state.tr.insertText("Left", inserted.state.selection.from).insertText("Right", inserted.state.selection.from + 6));
    // The cursor was in the first cell; type both words into it, then that isn't two cells.
    // Build the selection from a known grid instead.
    const doc = grid([
      ["Left", "Right"],
      ["Down", "End"],
    ]);
    const selected = selectCells(stateFor(doc), "Left", "Right");
    const merged = run(selected, mergeTableCells);
    assert.equal(merged.ok, true);
    const wide = cellByText(merged.state.doc, "LeftRight");
    assert.equal(wide.attrs.colspan, 2);
    assert.equal(merged.state.doc.child(0).child(0).childCount, 1);
    const split = run(merged.state, splitTableCell);
    assert.equal(split.ok, true);
    assert.equal(split.state.doc.child(0).child(0).childCount, 2);
    assert.equal(split.state.doc.child(0).child(0).child(0).attrs.colspan, 1);
  });

  it("splits one cell without adding a column to the other rows", () => {
    const doc = grid([
      ["A", "B"],
      ["C", "D"],
    ], false);
    const split = run(stateFor(doc, "A"), splitTableCell);
    assert.equal(split.ok, true);
    const row = split.state.doc.child(0).child(0);
    assert.equal(row.childCount, 3);
    assert.equal(split.state.doc.child(0).child(1).child(0).attrs.colspan, 2, "the cell below spans both halves");
  });

  it("splits a table above the current row", () => {
    const doc = grid([
      ["H1", "H2"],
      ["A", "B"],
      ["C", "D"],
    ]);
    const split = run(stateFor(doc, "A"), splitTable);
    assert.equal(split.ok, true);
    assert.equal(split.state.doc.child(0).type.name, "table");
    assert.equal(split.state.doc.child(0).childCount, 1);
    assert.equal(split.state.doc.child(1).type.name, "paragraph");
    assert.equal(split.state.doc.child(2).type.name, "table");
    assert.equal(split.state.doc.child(2).childCount, 2);
    assert.equal(run(stateFor(doc, "H1"), splitTable).ok, false, "the first row has nothing above it");
  });

  it("sets borders, shading, a column width and a row height, and distributes them", () => {
    const doc = grid([
      ["A", "B"],
      ["C", "D"],
    ]);
    const borders = run(stateFor(doc, "A"), setTableBorders("all"));
    assert.equal(borders.state.doc.child(0).attrs.borders.top.style, "solid");
    assert.equal(borders.state.doc.child(0).attrs.borders.insideV.color, "#000000");
    const none = run(borders.state, setTableBorders("none"));
    assert.equal(none.state.doc.child(0).attrs.borders.top.style, "nil");
    const shaded = run(stateFor(doc, "C"), setCellShading("#cfe2f3"));
    assert.equal(cellByText(shaded.state.doc, "C").attrs.background, "#cfe2f3");
    const width = run(stateFor(doc, "A"), setColumnWidth(144));
    assert.equal(cellByText(width.state.doc, "A").attrs.colwidth[0], 192);
    assert.equal(cellByText(width.state.doc, "C").attrs.colwidth[0], 192);
    const columns = run(width.state, distributeColumns);
    const left = cellByText(columns.state.doc, "A").attrs.colwidth[0];
    const right = cellByText(columns.state.doc, "B").attrs.colwidth[0];
    assert.equal(left, right);
    assert.ok(left > 0);
    const height = run(stateFor(doc, "A"), setRowHeight(36, "exact"));
    assert.equal(height.state.doc.child(0).child(0).attrs.height, 36);
    assert.equal(height.state.doc.child(0).child(0).attrs.heightRule, "exact");
    const rows = run(height.state, distributeRows);
    assert.equal(rows.state.doc.child(0).child(1).attrs.height, 36);
    const stored = schema.nodeFromJSON(rows.state.doc.toJSON());
    assert.equal(stored.child(0).child(1).attrs.height, 36, "a reload keeps the row height");
    assert.equal(stored.child(0).attrs.borders, null);
  });

  it("shows a SUM over a range and over the cells above, and updates it", () => {
    const labeled = grid(
      [
        ["2", "x"],
        ["3", "y"],
        ["z", "w"],
      ],
      false,
    );
    const ranged = run(stateFor(labeled, "z"), setCellFormula("=SUM(A1:A2)"));
    assert.equal(ranged.ok, true);
    assert.equal(cellByText(ranged.state.doc, "5").attrs.formula, "SUM(A1:A2)");
    const above = run(stateFor(labeled, "z"), setCellFormula("SUM(ABOVE)"));
    assert.equal(cellByText(above.state.doc, "5").textContent, "5");
    const left = run(stateFor(labeled, "y"), setCellFormula("SUM(LEFT)"));
    const leftCells: PMNode[] = [];
    left.state.doc.child(0).child(1).forEach((node) => {
      if (node.attrs.formula === "SUM(LEFT)") leftCells.push(node);
    });
    assert.equal(leftCells[0]?.textContent, "3");
    assert.equal(leftCells[0]?.attrs.formula, "SUM(LEFT)");
    let from = -1;
    above.state.doc.descendants((node, pos) => {
      if (from < 0 && node.isText && node.text === "2") from = pos;
    });
    const changed = above.state.apply(above.state.tr.insertText("8", from, from + 1));
    assert.equal(cellByText(changed.doc, "11").textContent, "11", "the sum follows the numbers");
    assert.deepEqual(
      [...formulaResults(changed.doc.child(0)).values()],
      ["11"],
    );
  });

  it("turns tabbed lines into a table and a table back into text", () => {
    const doc = schema.nodes.doc!.create(null, [
      schema.nodes.paragraph!.create(null, schema.text("a\tb")),
      schema.nodes.paragraph!.create(null, schema.text("c\td")),
    ]);
    const state = EditorState.create({ doc });
    const all = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, state.doc.content.size - 1)));
    const made = run(all, textToTable);
    assert.equal(made.ok, true);
    const table = made.state.doc.firstChild!;
    assert.equal(table.type.name, "table");
    assert.equal(table.childCount, 2);
    assert.equal(table.child(0).child(1).textContent, "b");
    assert.equal(table.child(1).child(0).textContent, "c");
    const text = run(made.state, tableToText);
    assert.equal(text.state.doc.child(0).textContent, "a\tb");
    assert.equal(text.state.doc.child(1).textContent, "c\td");
  });

  it("round-trips borders, shading, widths, a repeating header, a merge and a SUM through Word", async () => {
    const plain = await throughWord(markdownToDoc("| A | B |\n| --- | --- |\n| 1 | 2 |").firstChild!);
    assert.equal(plain.attrs.borders, null, "Inline's own grey grid is not stored as borders");
    assert.equal(plain.child(0).child(0).attrs.colwidth, null);
    assert.equal(plain.child(0).child(0).type.name, "table_header");

    const built = schema.nodes.table!.create({ borders: { top: { style: "solid", width: 1, color: "#000000" }, left: { style: "solid", width: 1, color: "#000000" }, bottom: { style: "solid", width: 1, color: "#000000" }, right: { style: "solid", width: 1, color: "#000000" }, insideH: { style: "nil", width: 0, color: null }, insideV: { style: "nil", width: 0, color: null } } }, [
      schema.nodes.table_row!.create({ height: 28, heightRule: "atLeast" }, [cell("Item", { colwidth: [96] }, true), cell("Qty", { colwidth: [96] }, true)]),
      schema.nodes.table_row!.create(null, [cell("Pens", { background: "#fce5cd" }), cell("2")]),
      schema.nodes.table_row!.create(null, [cell("Pads"), cell("3")]),
      schema.nodes.table_row!.create(null, [cell("Total", { colspan: 2, formula: "SUM(B2:B3)" }, false)]),
    ]);
    // The formula cell's text is filled the way the command would, so Word stores the result.
    const withResult = schema.nodes.table!.create(built.attrs, [
      built.child(0),
      built.child(1),
      built.child(2),
      schema.nodes.table_row!.create(null, [cell("5", { colspan: 2, formula: "SUM(B2:B3)" })]),
    ]);
    const back = await throughWord(withResult);
    assert.equal(back.child(0).child(0).type.name, "table_header");
    assert.equal(back.attrs.borders.top.style, "solid");
    assert.equal(back.attrs.borders.top.color, "#000000");
    assert.equal(back.attrs.borders.insideH.style, "nil");
    assert.equal(back.child(1).child(0).attrs.background, "#fce5cd");
    assert.equal(back.child(0).child(0).attrs.colwidth[0], 96);
    assert.equal(back.child(0).attrs.height, 28);
    assert.equal(back.child(3).child(0).attrs.colspan, 2);
    assert.equal(back.child(3).child(0).attrs.formula, "SUM(B2:B3)");
    assert.equal(back.child(3).child(0).textContent, "5");
    assert.equal(back.childCount, 4, "the merged cell is not repeated as an empty one");
  });
});

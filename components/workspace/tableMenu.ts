"use client";

import type { DocumentSession } from "@/lib/client/documentSession";
import {
  distributeColumns,
  distributeRows,
  mergeTableCells,
  setCellFormula,
  setCellShading,
  setColumnWidth,
  setRowHeight,
  setTableBorders,
  splitTable,
  splitTableCell,
  tableToText,
} from "@/lib/editor/tables";
import type { MenuItem } from "@/components/ui/Menu";

/** Opens the table dialog from any menu, including the phone's overflow menu. */
export type TableAsk = "width" | "height" | "formula";
export const TABLE_ASK = "inline:table-ask";

export function askTable(kind: TableAsk) {
  document.dispatchEvent(new CustomEvent<TableAsk>(TABLE_ASK, { detail: kind }));
}

const SHADES = [
  { label: "Yellow", color: "#fff2a8" },
  { label: "Blue", color: "#cfe2f3" },
  { label: "Green", color: "#d9ead3" },
  { label: "Gray", color: "#f3f4f6" },
];

/**
 * Format › Table, after the row and column commands that were already there.
 * Widths are in inches, the way the page setup talks about them.
 */
export function tableFormatItems(session: DocumentSession, notice: (message: string) => void): MenuItem[] {
  const run = session.run.bind(session);
  const fail = (command: Parameters<DocumentSession["run"]>[0], message: string) => () => {
    if (!run(command)) notice(message);
  };
  return [
    { kind: "separator" },
    { label: "Merge cells", onSelect: fail(mergeTableCells, "Select the cells you want to merge.") },
    { label: "Split cell", onSelect: fail(splitTableCell, "Put the cursor in a merged cell, or a cell that can be split.") },
    { label: "Split table", onSelect: fail(splitTable, "Put the cursor in the row that should start the new table.") },
    { kind: "separator" },
    {
      label: "Borders",
      submenu: [
        { label: "All borders", onSelect: fail(setTableBorders("all"), "Put the cursor in the table.") },
        { label: "Outside borders", onSelect: fail(setTableBorders("outside"), "Put the cursor in the table.") },
        { label: "Inside borders", onSelect: fail(setTableBorders("inside"), "Put the cursor in the table.") },
        { label: "No borders", onSelect: fail(setTableBorders("none"), "Put the cursor in the table.") },
      ],
    },
    {
      label: "Shading",
      submenu: [
        ...SHADES.map((shade) => ({ label: shade.label, onSelect: fail(setCellShading(shade.color), "Put the cursor in a cell.") })),
        { label: "No shading", onSelect: fail(setCellShading(null), "Put the cursor in a cell.") },
      ],
    },
    { kind: "separator" },
    {
      label: "Column width",
      submenu: [
        { label: "1 inch", onSelect: fail(setColumnWidth(72), "Put the cursor in the column.") },
        { label: "1.5 inches", onSelect: fail(setColumnWidth(108), "Put the cursor in the column.") },
        { label: "2 inches", onSelect: fail(setColumnWidth(144), "Put the cursor in the column.") },
        { label: "Custom…", onSelect: () => askTable("width") },
        { kind: "separator" },
        { label: "Distribute columns", onSelect: fail(distributeColumns, "Put the cursor in the table.") },
      ],
    },
    {
      label: "Row height",
      submenu: [
        { label: "0.3 inch", onSelect: fail(setRowHeight(21.6), "Put the cursor in the row.") },
        { label: "0.5 inch", onSelect: fail(setRowHeight(36), "Put the cursor in the row.") },
        { label: "Custom…", onSelect: () => askTable("height") },
        { kind: "separator" },
        { label: "Distribute rows", onSelect: fail(distributeRows, "Put the cursor in the table.") },
      ],
    },
    { kind: "separator" },
    {
      label: "Formula",
      submenu: [
        { label: "Sum above", onSelect: fail(setCellFormula("SUM(ABOVE)"), "Put the cursor in the cell that should show the sum.") },
        { label: "Sum to the left", onSelect: fail(setCellFormula("SUM(LEFT)"), "Put the cursor in the cell that should show the sum.") },
        { label: "Sum a range…", onSelect: () => askTable("formula") },
      ],
    },
    { label: "Convert to text", onSelect: fail(tableToText, "Put the cursor in the table.") },
  ];
}

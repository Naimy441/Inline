"use client";

import { useState } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";
import { insertTable } from "@/lib/editor/commands";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { TABLE_SIZE_MAX, TableSizeGrid, tableSize } from "@/components/workspace/TableSizeGrid";

/** Rows and columns typed, or dragged on the same grid the Insert menu shows. */
export function InsertTableDialog({ open, session, onClose, notice }: { open: boolean; session: DocumentSession; onClose: () => void; notice: (message: string) => void }) {
  const [rows, setRows] = useState("3");
  const [cols, setCols] = useState("4");
  const parsed = { rows: Math.floor(Number(rows)), cols: Math.floor(Number(cols)) };
  const insert = (nextRows: number, nextCols: number) => {
    if (!tableSize(nextRows, nextCols)) {
      notice(`Enter 1 to ${TABLE_SIZE_MAX} rows and columns.`);
      return;
    }
    if (!session.run(insertTable(nextRows, nextCols))) notice("Move the cursor out of a table first.");
    else onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Insert table"
      description="Rows × columns. Drag the grid, or type a size."
      width={360}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => insert(parsed.rows, parsed.cols)}>
            Insert
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          insert(parsed.rows, parsed.cols);
        }}
      >
        <TableSizeGrid rows={parsed.rows} cols={parsed.cols} onPick={(nextRows, nextCols) => {
          setRows(String(nextRows));
          setCols(String(nextCols));
        }} />
        <div className="table-size-fields">
          <label className="field">
            <span>Rows</span>
            <input className="input" type="number" min={1} max={TABLE_SIZE_MAX} inputMode="numeric" autoFocus aria-label="Rows" value={rows} onChange={(event) => setRows(event.target.value)} />
          </label>
          <label className="field">
            <span>Columns</span>
            <input className="input" type="number" min={1} max={TABLE_SIZE_MAX} inputMode="numeric" aria-label="Columns" value={cols} onChange={(event) => setCols(event.target.value)} />
          </label>
        </div>
      </form>
    </Dialog>
  );
}

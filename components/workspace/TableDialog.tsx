"use client";

import { useState } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";
import { setCellFormula, setColumnWidth, setRowHeight } from "@/lib/editor/tables";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import type { TableAsk } from "@/components/workspace/tableMenu";

/** A width, a height, or a SUM range, typed rather than picked from the menu. */
export function TableDialog({ kind, session, onClose, notice }: { kind: TableAsk | null; session: DocumentSession; onClose: () => void; notice: (message: string) => void }) {
  const [value, setValue] = useState("");
  const [exact, setExact] = useState(false);
  const title = kind === "width" ? "Column width" : kind === "height" ? "Row height" : "Sum a range";
  const apply = () => {
    if (kind === "formula") {
      const formula = value.trim().toUpperCase().startsWith("SUM") ? value.trim() : `SUM(${value.trim()})`;
      if (!session.run(setCellFormula(formula))) notice("Use a range like A1:B2, or put the cursor in a cell.");
      else onClose();
      return;
    }
    const inches = Number(value);
    if (!Number.isFinite(inches) || inches <= 0) {
      notice("Enter a size in inches.");
      return;
    }
    const points = inches * 72;
    const command = kind === "width" ? setColumnWidth(points) : setRowHeight(points, exact ? "exact" : "atLeast");
    if (!session.run(command)) notice("Put the cursor in the table.");
    else onClose();
  };
  return (
    <Dialog
      open={kind != null}
      onClose={onClose}
      title={title}
      description={kind === "formula" ? "SUM of cells, like A1:B2 or ABOVE." : "In inches."}
      width={360}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={apply}>
            Apply
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <label className="field">
          <span>{kind === "formula" ? "Range" : "Inches"}</span>
          <input
            key={kind ?? "closed"}
            autoFocus
            className="input"
            inputMode={kind === "formula" ? "text" : "decimal"}
            placeholder={kind === "formula" ? "A1:B2" : "1.5"}
            aria-label={title}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        {kind === "height" && (
          <label className="check">
            <input type="checkbox" checked={exact} onChange={(event) => setExact(event.target.checked)} />
            Exact height
          </label>
        )}
      </form>
    </Dialog>
  );
}

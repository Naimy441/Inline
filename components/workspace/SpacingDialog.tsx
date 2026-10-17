"use client";

import { useEffect, useState } from "react";
import type { DocumentSession } from "@/lib/client/documentSession";
import { setBlockSpacingOn, type BlockSpacingPatch } from "@/lib/editor/commands";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";

/** Google Docs' custom spacing: a line multiple, and space before and after in points. */
export function SpacingDialog({
  open,
  session,
  range,
  line,
  before,
  after,
  onClose,
}: {
  open: boolean;
  session: DocumentSession;
  range: { from: number; to: number } | null;
  line: string;
  before: number | null;
  after: number | null;
  onClose: () => void;
}) {
  const [lineValue, setLineValue] = useState(line);
  const [beforeValue, setBeforeValue] = useState(before == null ? "" : String(before));
  const [afterValue, setAfterValue] = useState(after == null ? "" : String(after));

  useEffect(() => {
    if (!open) return;
    setLineValue(line);
    setBeforeValue(before == null ? "" : String(before));
    setAfterValue(after == null ? "" : String(after));
    // The values are the selection's at the moment the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const apply = () => {
    const patch: BlockSpacingPatch = {};
    const multiple = Number(lineValue);
    if (Number.isFinite(multiple)) patch.lineHeight = String(Math.round(Math.min(10, Math.max(0.06, multiple)) * 100) / 100);
    const beforePt = Number(beforeValue);
    if (beforeValue.trim() !== "" && Number.isFinite(beforePt)) patch.spaceBefore = Math.round(Math.min(400, Math.max(0, beforePt)) * 10) / 10;
    const afterPt = Number(afterValue);
    if (afterValue.trim() !== "" && Number.isFinite(afterPt)) patch.spaceAfter = Math.round(Math.min(400, Math.max(0, afterPt)) * 10) / 10;
    const saved = range ?? { from: 0, to: 0 };
    session.run(setBlockSpacingOn(saved.from, saved.to, patch));
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Custom spacing"
      width={360}
      footer={
        <>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={apply}>
            Apply
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          <span>Line spacing</span>
          <input className="input" type="number" min={0.06} max={10} step={0.01} value={lineValue} onChange={(event) => setLineValue(event.target.value)} />
        </label>
        <label className="field">
          <span>Before (pt)</span>
          <input className="input" type="number" min={0} max={400} step={1} value={beforeValue} onChange={(event) => setBeforeValue(event.target.value)} />
        </label>
        <label className="field">
          <span>After (pt)</span>
          <input className="input" type="number" min={0} max={400} step={1} value={afterValue} onChange={(event) => setAfterValue(event.target.value)} />
        </label>
      </div>
    </Dialog>
  );
}

"use client";

import { useState, useSyncExternalStore } from "react";
import { getVersion } from "prosemirror-collab";
import { validateCanvasCss } from "@/lib/canvas/styles";
import { validateCanvasDocument } from "@/lib/canvas/model";
import { closeHistory } from "prosemirror-history";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { api } from "@/lib/client/api";
import type { DocumentSession } from "@/lib/client/documentSession";

type Source = { epoch: string; version: number; html: string; css: string };

export function CanvasTools({ session }: { session: DocumentSession }) {
  const ui = useSyncExternalStore(session.ui.subscribe, session.ui.get, session.ui.get);
  const [source, setSource] = useState<Source | null>(null);
  const [css, setCss] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (ui.meta?.kind !== "canvas") return null;
  const editable = ui.mode !== "viewing";
  const open = async () => {
    try {
      await session.whenSaved();
      const result = await api<Source>(`/api/documents/${session.id}/canvas`);
      setSource(result); setCss(result.css); setError("");
    } catch (e) { toast(e instanceof Error ? e.message : "Couldn't read the canvas.", { tone: "error" }); }
  };
  const apply = async () => {
    if (!source) return;
    setBusy(true); setError("");
    try {
      await session.whenSaved();
      const view = session.view;
      if (!view || getVersion(view.state) !== source.version) throw new Error("The canvas changed while this dialog was open. Close it and reopen to edit the latest design.");
      const validated = validateCanvasCss(css);
      const tr = closeHistory(view.state.tr).setDocAttribute("canvas", { format: 1, css: validated });
      validateCanvasDocument(tr.doc);
      view.dispatch(tr);
      setSource(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't apply the design."); }
    finally { setBusy(false); }
  };
  return <>
    <div className="canvas-design-tools" aria-label="Canvas design tools">
      <span className="canvas-label">Canvas · editable pages</span>
      {editable && <button type="button" onClick={() => void open()}>Edit design</button>}
    </div>
    <Dialog open={!!source} onClose={() => !busy && setSource(null)} title="Canvas design" description="Edit the stylesheet without changing any words. Ask Claude for a new composition or visual direction." width={720} footer={<><Button onClick={() => setSource(null)} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void apply()}>Apply design</Button></>}>
      <div className="canvas-source-fields"><label htmlFor="canvas-stylesheet">Stylesheet</label><textarea id="canvas-stylesheet" value={css} onChange={(e) => setCss(e.target.value)} spellCheck={false} /><details><summary>Current composition (read only)</summary><textarea value={source?.html || ""} readOnly spellCheck={false} aria-label="Current Canvas composition" /></details>{error && <div className="canvas-design-error" role="alert">{error}</div>}</div>
    </Dialog>
  </>;
}

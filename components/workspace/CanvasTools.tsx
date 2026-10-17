"use client";

import { useState, useSyncExternalStore } from "react";
import { getVersion } from "prosemirror-collab";
import { validateCanvasCss } from "@/lib/canvas/styles";
import { validateCanvasDocument } from "@/lib/canvas/model";
import { closeHistory } from "prosemirror-history";
import { TextSelection } from "prosemirror-state";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { api } from "@/lib/client/api";
import type { DocumentSession } from "@/lib/client/documentSession";
import type { CanvasIssue } from "@/lib/canvas/editor";

type Source = { epoch: string; version: number; html: string; css: string };

export function CanvasTools({ session }: { session: DocumentSession }) {
  const ui = useSyncExternalStore(session.ui.subscribe, session.ui.get, session.ui.get);
  const [source, setSource] = useState<Source | null>(null);
  const [css, setCss] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<CanvasIssue[] | null>(null);
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
      setSource(null); setIssues(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't apply the design."); }
    finally { setBusy(false); }
  };
  const check = async () => {
    try { setIssues((await session.prepareCanvasRender()).issues); }
    catch (e) { toast(e instanceof Error ? e.message : "Couldn't inspect the pages.", { tone: "error" }); }
  };
  const selectSection = () => {
    const view = session.view;
    if (!view) return;
    const { $from } = view.state.selection;
    const pos = $from.depth > 0 ? $from.before(1) : 0;
    const node = view.state.doc.nodeAt(pos);
    if (!node) return;
    view.dispatch(view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(pos + 1), view.state.doc.resolve(Math.max(pos + 1, pos + node.nodeSize - 1)))));
    view.focus();
  };
  const move = (direction: -1 | 1) => {
    const view = session.view;
    if (!view) return;
    const { $from } = view.state.selection;
    const index = $from.index(0);
    const doc = view.state.doc;
    const sibling = index + direction;
    if (sibling < 0 || sibling >= doc.childCount) return;
    let pos = 0; for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
    const node = doc.child(index);
    const destination = direction < 0 ? pos - doc.child(sibling).nodeSize : pos + doc.child(sibling).nodeSize;
    const tr = closeHistory(view.state.tr).delete(pos, pos + node.nodeSize).insert(destination, node);
    tr.setSelection(TextSelection.near(tr.doc.resolve(destination + 1)));
    view.dispatch(tr.scrollIntoView()); view.focus(); setIssues(null);
  };
  return <>
    <div className="canvas-design-tools" aria-label="Canvas design tools">
      <span className="canvas-label">Canvas · editable pages</span>
      <button type="button" onClick={() => void check()}>Check layout</button>
      {editable && <>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={selectSection}>Select section</button>
        <button type="button" aria-label="Move section up" onMouseDown={(e) => e.preventDefault()} onClick={() => move(-1)}>↑</button>
        <button type="button" aria-label="Move section down" onMouseDown={(e) => e.preventDefault()} onClick={() => move(1)}>↓</button>
        <button type="button" onClick={() => void open()}>Edit design</button>
      </>}
    </div>
    {issues && <div className="canvas-layout-notice" role="status">{issues.length ? issues.map((issue, i) => <div key={`${issue.id}-${i}`}>{issue.id}: {issue.message}</div>) : "Layout checked: no overflow or unsupported page decorations found."}</div>}
    <Dialog open={!!source} onClose={() => !busy && setSource(null)} title="Canvas design" description="Edit the stylesheet without changing any words. Ask Claude for a new composition or visual direction." width={720} footer={<><Button onClick={() => setSource(null)} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void apply()}>Apply design</Button></>}>
      <div className="canvas-source-fields"><label htmlFor="canvas-stylesheet">Stylesheet</label><textarea id="canvas-stylesheet" value={css} onChange={(e) => setCss(e.target.value)} spellCheck={false} /><details><summary>Current composition (read only)</summary><textarea value={source?.html || ""} readOnly spellCheck={false} aria-label="Current Canvas composition" /></details>{error && <div className="canvas-design-error" role="alert">{error}</div>}</div>
    </Dialog>
  </>;
}

"use client";

import { History, RotateCcw, Save, Sparkles, X } from "lucide-react";
import { DOMSerializer, Node as PMNode } from "prosemirror-model";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, post } from "@/lib/client/api";
import type { DocumentSession } from "@/lib/client/documentSession";
import { schema } from "@/lib/doc/schema";
import { diffParagraphs, diffStats } from "@/lib/doc/textDiff";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";

type VersionSummary = { id: string; documentId: string; label: string; author: "user" | "claude" | "auto"; createdAt: number; wordCount?: number };

function stamp(at: number) {
  return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function HistoryPanel({ session, onClose }: { session: DocumentSession; onClose: () => void }) {
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [preview, setPreview] = useState<VersionSummary | null>(null);
  const [label, setLabel] = useState("");

  const load = useCallback(async () => {
    const result = await api<{ versions: VersionSummary[] }>(`/api/documents/${session.id}/versions`).catch(() => ({ versions: [] }));
    setVersions(result.versions);
  }, [session.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    await session.whenSaved();
    await post(`/api/documents/${session.id}/versions`, { label: label.trim() || "Saved version" });
    setLabel("");
    toast("Version saved.", { tone: "success" });
    void load();
  };

  return (
    <aside className="side-panel" aria-label="Version history">
      <header className="panel-header">
        <div className="panel-title">
          <span className="panel-title-text">Version history</span>
        </div>
        <div className="panel-actions">
          <IconButton label="Close history" size="sm" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
      </header>
      <div className="history-save">
        <input className="input" placeholder="Name this version (optional)" value={label} onChange={(event) => setLabel(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void save()} />
        <Button icon={<Save size={14} />} onClick={() => void save()}>
          Save
        </Button>
      </div>
      <div className="panel-scroll">
        {versions === null ? null : versions.length === 0 ? (
          <div className="panel-empty small">
            <History size={20} />
            <p>Versions are saved automatically as you work and before Claude edits, so you can always go back.</p>
          </div>
        ) : (
          <ul className="version-list">
            {versions.map((version) => (
              <li key={version.id}>
                <button type="button" className="version-row" onClick={() => setPreview(version)}>
                  <span className="version-label">
                    {version.author === "claude" && <Sparkles size={12} />}
                    {version.label}
                  </span>
                  <span className="version-time">{stamp(version.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <VersionPreview
        session={session}
        version={preview}
        onClose={() => setPreview(null)}
        onRestored={() => {
          setPreview(null);
          void load();
        }}
      />
    </aside>
  );
}

function VersionPreview({ session, version, onClose, onRestored }: { session: DocumentSession; version: VersionSummary | null; onClose: () => void; onRestored: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<{ doc: unknown } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [comparing, setComparing] = useState(false);

  const comparison = useMemo(() => {
    if (!comparing || !loaded || !session.view) return null;
    try {
      const before = PMNode.fromJSON(schema, loaded.doc as Parameters<typeof PMNode.fromJSON>[1]);
      const blocks = (doc: PMNode) => doc.textBetween(0, doc.content.size, "\n", "");
      const paragraphs = diffParagraphs(blocks(before), blocks(session.view.state.doc));
      return { paragraphs, ...diffStats(paragraphs) };
    } catch {
      return null;
    }
  }, [comparing, loaded, session.view]);

  useEffect(() => {
    setLoaded(null);
    setComparing(false);
    if (!version) return;
    void api<{ version: { doc: unknown } }>(`/api/documents/${session.id}/versions/${version.id}`).then((result) => setLoaded(result.version));
  }, [session.id, version]);

  useEffect(() => {
    const element = container.current;
    if (!element || !loaded) return;
    try {
      const doc = PMNode.fromJSON(schema, loaded.doc as Parameters<typeof PMNode.fromJSON>[1]);
      element.replaceChildren(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
    } catch {
      element.textContent = "This version can't be previewed.";
    }
  }, [loaded]);

  return (
    <Dialog
      open={Boolean(version)}
      onClose={onClose}
      title={version?.label ?? ""}
      description={version ? stamp(version.createdAt) : undefined}
      width={760}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            icon={<RotateCcw size={14} />}
            loading={restoring}
            onClick={async () => {
              if (!version) return;
              setRestoring(true);
              try {
                await session.whenSaved();
                const hadPending = session.ui.get().hunks.length > 0;
                await post(`/api/documents/${session.id}/versions/${version.id}/restore`);
                toast(
                  hadPending
                    ? "Version restored. The previous state, with its pending changes, was saved to history."
                    : "Version restored. The previous state was saved to history.",
                  { tone: "success" },
                );
                onRestored();
              } finally {
                setRestoring(false);
              }
            }}
          >
            Restore this version
          </Button>
        </>
      }
    >
      {!loaded && <p className="muted">Loading…</p>}
      {loaded && (
        <div className="version-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={!comparing} className={`version-tab${comparing ? "" : " is-active"}`} onClick={() => setComparing(false)}>
            This version
          </button>
          <button type="button" role="tab" aria-selected={comparing} className={`version-tab${comparing ? " is-active" : ""}`} onClick={() => setComparing(true)}>
            Compare with now
          </button>
          {comparison && (
            <span className="version-stats">
              <span className="change-stat add">+{comparison.added}</span> <span className="change-stat del">−{comparison.removed}</span> words since this version
            </span>
          )}
        </div>
      )}
      <div className="version-preview doc-content" ref={container} hidden={comparing} />
      {comparing && comparison && (
        <div className="version-preview version-diff" aria-label="Changes since this version">
          {comparison.added + comparison.removed === 0 ? (
            <p className="muted">No text changes since this version.</p>
          ) : (
            comparison.paragraphs.map((paragraph, index) =>
              paragraph.kind === "same" && !paragraph.parts[0]!.text ? null : (
                <p key={index} className={`diff-para is-${paragraph.kind}`}>
                  {paragraph.parts.map((part, i) =>
                    part.kind === "insert" ? <ins key={i}>{part.text}</ins> : part.kind === "delete" ? <del key={i}>{part.text}</del> : <span key={i}>{part.text}</span>,
                  )}
                </p>
              ),
            )
          )}
        </div>
      )}
    </Dialog>
  );
}

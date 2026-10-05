"use client";

import { History, RotateCcw, Save, Sparkles, X } from "lucide-react";
import { DOMSerializer, Node as PMNode } from "prosemirror-model";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, post } from "@/lib/client/api";
import type { DocumentSession } from "@/lib/client/documentSession";
import { schema } from "@/lib/doc/schema";
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

  useEffect(() => {
    setLoaded(null);
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
      <div className="version-preview doc-content" ref={container} />
    </Dialog>
  );
}

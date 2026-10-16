"use client";

import { ChevronDown, ChevronUp, FileText, FolderSearch, History, RotateCcw, Save, Sparkles, X } from "lucide-react";
import { DOMSerializer, Node as PMNode } from "prosemirror-model";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, post } from "@/lib/client/api";
import { loadServerPlatform, revealLabel } from "@/lib/client/fileManager";
import type { DocumentSession } from "@/lib/client/documentSession";
import { refreshVersions, useVersions, versionDoc, type VersionSummary } from "@/lib/client/versions";
import { schema } from "@/lib/doc/schema";
import { diffParagraphs, diffStats } from "@/lib/doc/textDiff";
import { Button, IconButton } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";

export type { VersionSummary };

function time(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function stamp(at: number) {
  return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function dayLabel(at: number) {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) });
}

const AUTHORS = { user: "You", claude: "Claude" } as const;

/**
 * Files saved with the version on screen. "Open with…" hands that one file to
 * the system's app chooser. The folder button opens the directory that holds
 * all of them.
 */
function VersionFiles({
  documentId,
  versionId,
  files,
  preview,
}: {
  documentId: string;
  versionId: string | null;
  files: Array<{ path: string; kind: string }>;
  /** Current files can preview an image. A saved version's copy is not the live file. */
  preview: boolean;
}) {
  const [os, setOs] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void loadServerPlatform().then(setOs);
  }, []);

  const open = async (key: string, file?: string) => {
    setBusy(key);
    try {
      await post(`/api/documents/${documentId}/versions/open`, {
        ...(versionId ? { versionId } : {}),
        ...(file ? { file } : {}),
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't open that.", { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const folderLabel = revealLabel(os);
  return (
    <section className="history-files" aria-label={versionId ? "Files in this version" : "Files"}>
      <div className="history-files-bar">
        <div className="version-day">{versionId ? "Files in this version" : "Files"}</div>
        <Button size="sm" variant="ghost" className="history-folder" icon={<FolderSearch size={14} />} loading={busy === "folder"} disabled={busy !== null} onClick={() => void open("folder")}>
          {folderLabel}
        </Button>
      </div>
      <ul>
        {files.map((file) => {
          const href = `/api/documents/${documentId}/files/${file.path.split("/").map(encodeURIComponent).join("/")}`;
          return (
            <li key={file.path} className="history-file-row">
              {preview && file.kind === "image" ? (
                <a className="history-file" href={href} target="_blank" rel="noreferrer">
                  <img src={href} alt="" />
                  <span title={file.path}>{file.path}</span>
                </a>
              ) : (
                <span className="history-file">
                  <FileText size={14} />
                  <span title={file.path}>{file.path}</span>
                </span>
              )}
              <Button size="sm" variant="ghost" className="history-file-open" loading={busy === file.path} disabled={busy !== null} aria-label={`Open ${file.path} with…`} onClick={() => void open(file.path, file.path)}>
                Open with…
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The version list. Picking one shows it in place of the document (see VersionPreview). */
export function HistoryPanel({
  session,
  selected,
  onSelect,
  onClose,
  hideAi = false,
}: {
  session: DocumentSession;
  selected: VersionSummary | null;
  onSelect: (version: VersionSummary | null) => void;
  onClose: () => void;
  /** Focus mode: the empty state doesn't mention Claude, and Claude's versions aren't badged. */
  hideAi?: boolean;
}) {
  const versions = useVersions(session.id);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [files, setFiles] = useState<Array<{ path: string; kind: string; size: number }> | null>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ files: Array<{ path: string; kind: string; size: number }> }>(`/api/documents/${session.id}/files`)
      .then((result) => {
        if (!cancelled) setFiles(result.files);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [session.id, versions]);

  const shownFiles = selected ? (selected.files ?? []).map((filePath) => ({ path: filePath, kind: "other" as const })) : files;

  const groups = useMemo(() => {
    const result: Array<{ day: string; versions: VersionSummary[] }> = [];
    for (const version of versions ?? []) {
      const day = dayLabel(version.createdAt);
      const last = result[result.length - 1];
      if (last?.day === day) last.versions.push(version);
      else result.push({ day, versions: [version] });
    }
    return result;
  }, [versions]);

  // Arrow keys step through versions while one is shown.
  useEffect(() => {
    if (!selected || !versions?.length) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if ((event.target as HTMLElement | null)?.closest("input, textarea, [contenteditable=true]")) return;
      const index = versions.findIndex((version) => version.id === selected.id);
      const next = versions[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      onSelect(next);
      list.current?.querySelector(`[data-version="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected, versions, onSelect]);

  const save = async () => {
    setSaving(true);
    try {
      await session.whenSaved();
      await post(`/api/documents/${session.id}/versions`, { label: label.trim() || "Saved version" });
      setLabel("");
      toast("Version saved.", { tone: "success" });
      await refreshVersions(session.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't save a version.", { tone: "error" });
    } finally {
      setSaving(false);
    }
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
        <input className="input" placeholder="Name the current version" value={label} onChange={(event) => setLabel(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void save()} />
        <Button icon={<Save size={14} />} loading={saving} onClick={() => void save()}>
          Save
        </Button>
      </div>
      <div className="panel-scroll">
        <button type="button" className={`version-row version-current${selected ? "" : " is-selected"}`} onClick={() => onSelect(null)}>
          <span className="version-label">Current version</span>
          <span className="version-time">Now</span>
        </button>
        {versions === null ? (
          <div className="version-skeleton" aria-hidden>
            <span />
            <span />
            <span />
          </div>
        ) : versions.length === 0 ? (
          <div className="panel-empty small">
            <History size={20} />
            <p>Nothing is saved as a version yet. What you type is kept on this computer. Save names a version you can come back to, including files made for this document.</p>
          </div>
        ) : (
          <ul className="version-list" ref={list}>
            {groups.map((group) => (
              <li key={group.day}>
                <div className="version-day">{group.day}</div>
                <ul>
                  {group.versions.map((version) => (
                    <li key={version.id}>
                      <button
                        type="button"
                        data-version={version.id}
                        className={`version-row${selected?.id === version.id ? " is-selected" : ""}`}
                        aria-current={selected?.id === version.id}
                        onClick={() => onSelect(version)}
                        onPointerEnter={() => void versionDoc(session.id, version.id).catch(() => undefined)}
                      >
                        <span className="version-label">{version.label}</span>
                        <span className="version-time">
                          {time(version.createdAt)}
                          {!(hideAi && version.author === "claude") && (
                            <span className={`version-author is-${version.author}`}>
                              {version.author === "claude" && <Sparkles size={11} />}
                              {AUTHORS[version.author]}
                            </span>
                          )}
                          {version.wordCount != null && <span>{version.wordCount.toLocaleString()} words</span>}
                          {version.files && version.files.length > 0 && <span>{version.files.length === 1 ? version.files[0] : `${version.files.length} files`}</span>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {shownFiles && shownFiles.length > 0 && (
          <VersionFiles documentId={session.id} versionId={selected?.id ?? null} files={shownFiles} preview={!selected} />
        )}
      </div>
    </aside>
  );
}

/**
 * A saved version shown in place of the document, with its differences from
 * the current text one click away, and a way back or to restore it.
 */
type View = "version" | "changes" | "since";

const blocksText = (node: PMNode) => node.textBetween(0, node.content.size, "\n", "");

/**
 * A saved version shown in place of the document. "Changes" marks what the
 * version changed from the one before it, with arrows to step through each
 * change; "Since then" compares it with the current text.
 */
export function VersionPreview({ session, version, onClose }: { session: DocumentSession; version: VersionSummary; onClose: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const diffRef = useRef<HTMLDivElement>(null);
  const versions = useVersions(session.id);
  const index = versions?.findIndex((item) => item.id === version.id) ?? -1;
  const previous = index >= 0 ? (versions![index + 1] ?? null) : undefined;
  const [doc, setDoc] = useState<PMNode | null>(null);
  const [before, setBefore] = useState<PMNode | null>(null);
  const [failed, setFailed] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [view, setView] = useState<View>("version");
  const [current, setCurrent] = useState(-1);
  const comparing = view !== "version";

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    versionDoc(session.id, version.id)
      .then((json) => {
        if (!cancelled) setDoc(PMNode.fromJSON(schema, json as Parameters<typeof PMNode.fromJSON>[1]));
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [session.id, version.id]);

  // The version before this one, which "Changes" compares against (the first version compares with an empty page).
  useEffect(() => {
    setBefore(null);
    if (previous === undefined) return;
    if (previous === null) {
      setBefore(schema.node("doc", null, [schema.node("paragraph")]));
      return;
    }
    let cancelled = false;
    versionDoc(session.id, previous.id)
      .then((json) => !cancelled && setBefore(PMNode.fromJSON(schema, json as Parameters<typeof PMNode.fromJSON>[1])))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session.id, previous]);

  const comparison = useMemo(() => {
    if (!doc) return null;
    let paragraphs;
    if (view === "changes") {
      if (!before) return null;
      paragraphs = diffParagraphs(blocksText(before), blocksText(doc));
    } else if (view === "since" && session.view) {
      paragraphs = diffParagraphs(blocksText(doc), blocksText(session.view.state.doc));
    } else return null;
    // Each changed paragraph is a stop for the arrows.
    const stops: number[] = [];
    paragraphs.forEach((paragraph, i) => {
      if (paragraph.kind !== "same") stops.push(i);
    });
    return { paragraphs, stops, ...diffStats(paragraphs) };
  }, [view, doc, before, session.view]);

  useEffect(() => setCurrent(-1), [version.id]);

  useEffect(() => {
    const element = container.current;
    if (!element || !doc || comparing) return;
    element.replaceChildren(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
  }, [doc, comparing]);

  const stops = comparison?.stops ?? [];
  const step = (direction: 1 | -1) => {
    if (!comparing) {
      // From the plain version, the arrows open its changes at the first (or last) one.
      setView("changes");
      setCurrent(direction > 0 ? 0 : -2);
      return;
    }
    if (!stops.length) return;
    setCurrent((value) => (value < 0 ? (direction > 0 ? 0 : stops.length - 1) : Math.max(0, Math.min(stops.length - 1, value + direction))));
  };

  // Bring the change the arrows landed on into view.
  useEffect(() => {
    if (current === -2 && stops.length) setCurrent(stops.length - 1);
    if (current < 0) return;
    const stop = stops[current];
    const element = diffRef.current?.querySelector<HTMLElement>(`[data-diff="${stop}"]`);
    element?.scrollIntoView({ block: "center" });
  }, [current, stops]);

  // [ and ] step through the changes, like the arrows.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as HTMLElement | null)?.closest("input, textarea, [contenteditable=true]")) return;
      if (event.key !== "[" && event.key !== "]") return;
      event.preventDefault();
      step(event.key === "]" ? 1 : -1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const restore = async (discard: boolean) => {
    setRestoring(true);
    try {
      await session.whenSaved();
      await post(`/api/documents/${session.id}/versions/${version.id}/restore`, { discard });
      toast(discard ? "Version restored. Changes since the last saved version were dropped." : "Version restored.", { tone: "success" });
      void refreshVersions(session.id);
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.body.unsaved) {
        setDiscarding(true);
        return;
      }
      toast(error instanceof Error ? error.message : "Couldn't restore that version.", { tone: "error" });
    } finally {
      setRestoring(false);
    }
  };

  const activeStop = current >= 0 ? stops[current] : undefined;
  const settings = session.meta?.settings;
  return (
    <div className="version-view" aria-label={`Version: ${version.label}`}>
      <div className="version-bar">
        <div className="version-bar-title">
          <strong>{version.label}</strong>
          <span className="muted">
            {stamp(version.createdAt)} · {AUTHORS[version.author]}
          </span>
        </div>
        <div className="version-bar-actions">
          <div className="segmented" role="tablist" aria-label="Show">
            {(
              [
                ["version", "This version"],
                ["changes", "Changes"],
                ["since", "Since then"],
              ] as const
            ).map(([value, label]) => (
              <button key={value} type="button" role="tab" aria-selected={view === value} className={view === value ? "is-active" : ""} onClick={() => {
                  setView(value);
                  setCurrent(-1);
                }}>
                {label}
              </button>
            ))}
          </div>
          <div className="change-stepper" role="group" aria-label="Step through changes">
            <IconButton label="Previous change" shortcut="[" size="sm" disabled={comparing && (!stops.length || current === 0)} onClick={() => step(-1)}>
              <ChevronUp size={16} />
            </IconButton>
            <span className="change-count" aria-live="polite">
              {!comparing || !comparison ? "Changes" : !stops.length ? "No changes" : current < 0 ? `${stops.length} change${stops.length === 1 ? "" : "s"}` : `${current + 1} of ${stops.length}`}
            </span>
            <IconButton label="Next change" shortcut="]" size="sm" disabled={comparing && (!stops.length || current === stops.length - 1)} onClick={() => step(1)}>
              <ChevronDown size={16} />
            </IconButton>
          </div>
          <Button variant="ghost" onClick={onClose}>
            Back to current
          </Button>
          {discarding ? (
            <Button variant="primary" icon={<RotateCcw size={14} />} loading={restoring} onClick={() => void restore(true)}>
              Restore anyway
            </Button>
          ) : (
            <Button variant="primary" icon={<RotateCcw size={14} />} loading={restoring} onClick={() => void restore(false)}>
              Restore
            </Button>
          )}
        </div>
      </div>
      {discarding && <div className="version-stats">This document has changes that are not a saved version. Restore anyway drops them. Save a version first if you want to keep them.</div>}
      {comparison && (
        <div className="version-stats">
          {comparison.added + comparison.removed === 0 ? (
            view === "changes" ? "No text changed in this version." : "No text changes between this version and now."
          ) : (
            <>
              <span className="change-stat add">+{comparison.added}</span> <span className="change-stat del">−{comparison.removed}</span>{" "}
              {view === "changes" ? (previous ? "words changed in this version" : "words in the first version") : "words changed since this version"}
            </>
          )}
        </div>
      )}
      <div className="version-page" style={settings ? { fontFamily: settings.fontFamily, fontSize: `${settings.fontSize}pt`, lineHeight: String(settings.lineSpacing) } : undefined}>
        {failed ? (
          <p className="muted">This version couldn&apos;t be loaded.</p>
        ) : !doc || (comparing && !comparison) ? (
          <div className="version-skeleton" aria-hidden>
            <span />
            <span />
            <span />
          </div>
        ) : comparing && comparison ? (
          <div key="diff" ref={diffRef} className="version-diff doc-content" aria-label={view === "changes" ? "Changes in this version" : "Changes since this version"}>
            {comparison.paragraphs.map((paragraph, i) => {
              if (paragraph.kind === "same" && !paragraph.parts[0]!.text) return null;
              const focused = i === activeStop;
              return (
                <p key={i} data-diff={i} className={`diff-para is-${paragraph.kind}${focused ? " is-focused" : ""}`}>
                  {paragraph.parts.map((part, j) => (part.kind === "insert" ? <ins key={j}>{part.text}</ins> : part.kind === "delete" ? <del key={j}>{part.text}</del> : <span key={j}>{part.text}</span>))}
                </p>
              );
            })}
          </div>
        ) : (
          <div key="version" className="doc-content" ref={container} />
        )}
      </div>
    </div>
  );
}

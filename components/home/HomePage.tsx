"use client";

import { Copy, Download, FilePlus2, FileText, FileUp, Moon, MoreVertical, Pencil, Plus, RotateCcw, Search, Sun, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, del, patch, post } from "@/lib/client/api";
import { dismissLegacyDocuments, hasLegacyDocuments, htmlToDocJSON, importLegacyDocuments } from "@/lib/client/legacyImport";
import { useTheme } from "@/lib/client/theme";
import type { DocumentMeta } from "@/lib/doc/settings";
import { documentTemplates, type DocumentTemplate } from "@/lib/doc/templates";
import { AgentStatusBadge } from "@/components/agent/AgentStatusBadge";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Menu } from "@/components/ui/Menu";
import { toast } from "@/components/ui/Toast";
import { confirmDialog } from "@/components/ui/Confirm";
import { InlineLogo } from "@/components/ui/Logo";

type Snapshot = { meta: DocumentMeta };

function relativeTime(at: number) {
  const diff = Date.now() - at;
  const minute = 60_000;
  if (diff < minute) return "Just now";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} min ago`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} h ago`;
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

export function HomePage() {
  const router = useRouter();
  const [documents, setDocuments] = useState<DocumentMeta[] | null>(null);
  const [trashed, setTrashed] = useState<DocumentMeta[]>([]);
  const [view, setView] = useState<"recent" | "trash">("recent");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState<string | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [renaming, setRenaming] = useState<DocumentMeta | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { dark, toggle } = useTheme();
  const templates = useMemo(() => documentTemplates(), []);

  const load = useCallback(async () => {
    try {
      const [live, trash] = await Promise.all([
        api<{ documents: DocumentMeta[] }>("/api/documents"),
        api<{ documents: DocumentMeta[] }>("/api/documents?trashed=1"),
      ]);
      setDocuments(live.documents);
      setTrashed(trash.documents);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't load documents.", { tone: "error" });
      setDocuments([]);
    }
  }, []);

  useEffect(() => {
    document.title = "Inline";
    void load();
    setLegacy(hasLegacyDocuments());
  }, [load]);

  const open = (id: string) => router.push(`/d/${id}`);

  const create = async (template: DocumentTemplate) => {
    setCreating(template.id);
    try {
      const { document } = await post<{ document: Snapshot }>("/api/documents", {
        title: template.documentTitle,
        markdown: template.markdown,
        settings: template.settings,
      });
      const suffix = template.suggestion ? `?ask=${encodeURIComponent(template.suggestion)}` : "";
      router.push(`/d/${document.meta.id}${suffix}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't create the document.", { tone: "error" });
      setCreating(null);
    }
  };

  const importFile = async (file: File) => {
    try {
      if (/\.docx$/i.test(file.name)) {
        const form = new FormData();
        form.append("file", file);
        const { document } = await api<{ document: Snapshot }>("/api/documents/import", { method: "POST", body: form });
        open(document.meta.id);
        return;
      }
      const text = await file.text();
      const title = file.name.replace(/\.[^.]+$/, "") || "Imported document";
      const body = /\.html?$/i.test(file.name) ? { title, doc: htmlToDocJSON(text) } : { title, markdown: text };
      const { document } = await post<{ document: Snapshot }>("/api/documents", body);
      open(document.meta.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't import that file.", { tone: "error" });
    }
  };

  const runLegacyImport = async () => {
    try {
      const count = await importLegacyDocuments();
      setLegacy(false);
      toast(`Imported ${count} document${count === 1 ? "" : "s"} from the previous version.`, { tone: "success" });
      void load();
    } catch {
      toast("Couldn't import your earlier documents.", { tone: "error" });
    }
  };

  const filtered = useMemo(() => {
    const list = view === "trash" ? trashed : (documents ?? []);
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((doc) => doc.title.toLowerCase().includes(q) || doc.preview.toLowerCase().includes(q));
  }, [documents, trashed, view, query]);

  const moveToTrash = async (doc: DocumentMeta) => {
    await patch(`/api/documents/${doc.id}`, { trashed: true });
    toast(`Moved "${doc.title}" to trash.`, {
      action: {
        label: "Undo",
        run: () => void patch(`/api/documents/${doc.id}`, { trashed: false }).then(load),
      },
    });
    void load();
  };

  return (
    <div className="home">
      <header className="home-header">
        <div className="home-brand">
          <InlineLogo />
          <span>Inline</span>
        </div>
        <div className="home-search">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search documents" aria-label="Search documents" />
        </div>
        <div className="home-header-actions">
          <AgentStatusBadge />
          <IconButton label={dark ? "Light theme" : "Dark theme"} onClick={toggle}>
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </IconButton>
        </div>
      </header>

      <main className="home-main">
        {legacy && (
          <div className="home-banner">
            <span>Documents from the previous version of Inline were found in this browser.</span>
            <Button size="sm" variant="primary" onClick={runLegacyImport}>
              Import them
            </Button>
            <IconButton
              label="Dismiss"
              size="sm"
              className="home-banner-close"
              onClick={() => {
                dismissLegacyDocuments();
                setLegacy(false);
              }}
            >
              <X size={15} />
            </IconButton>
          </div>
        )}

        <section className="home-section">
          <div className="home-section-head">
            <h2>Start something new</h2>
            <Button size="sm" variant="ghost" icon={<FileUp size={15} />} onClick={() => fileInput.current?.click()}>
              Import file
            </Button>
            <Button size="sm" variant="ghost" icon={<Download size={15} />} onClick={() => window.location.assign("/api/documents/backup")}>
              Download all
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".docx,.md,.markdown,.txt,.html,.htm"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importFile(file);
                event.target.value = "";
              }}
            />
          </div>
          <div className="template-row">
            {templates.map((template) => (
              <button key={template.id} type="button" className="template-card" onClick={() => void create(template)} disabled={creating !== null}>
                <TemplateThumb template={template} />
                <span className="template-title">{creating === template.id ? "Creating…" : template.title}</span>
                <span className="template-desc">{template.description}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <div className="segmented" role="tablist">
              <button type="button" role="tab" aria-selected={view === "recent"} className={view === "recent" ? "is-active" : ""} onClick={() => setView("recent")}>
                Recent
              </button>
              <button type="button" role="tab" aria-selected={view === "trash"} className={view === "trash" ? "is-active" : ""} onClick={() => setView("trash")}>
                Trash{trashed.length ? ` (${trashed.length})` : ""}
              </button>
            </div>
            {view === "trash" && trashed.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 size={15} />}
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: "Empty the trash?",
                    body: `${trashed.length} document${trashed.length === 1 ? " is" : "s are"} deleted forever. This can't be undone.`,
                    confirmLabel: "Delete forever",
                    danger: true,
                  });
                  if (!ok) return;
                  try {
                    const { deleted } = await del<{ deleted: number }>("/api/documents?trashed=1");
                    toast(`Deleted ${deleted} document${deleted === 1 ? "" : "s"} permanently.`);
                  } catch (error) {
                    toast(error instanceof Error ? error.message : "Couldn't empty the trash.", { tone: "error" });
                  }
                  void load();
                }}
              >
                Empty trash
              </Button>
            )}
          </div>
          {view === "trash" && <p className="home-note">Documents in the trash are deleted forever after 30 days.</p>}

          {documents === null ? (
            <div className="doc-grid">
              {[0, 1, 2, 3].map((key) => (
                <div key={key} className="doc-card skeleton">
                  <div className="doc-card-cover" />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="home-empty">
              {view === "trash" ? (
                "Trash is empty."
              ) : query ? (
                `No documents match "${query}".`
              ) : (
                <>
                  <FileText size={28} />
                  <p>No documents yet. Pick a template above to start, then ask Claude to help you write.</p>
                </>
              )}
            </div>
          ) : (
            <div className="doc-grid">
              {filtered.map((doc) => (
                <DocumentCard
                  key={doc.id}
                  doc={doc}
                  trashed={view === "trash"}
                  onOpen={() => open(doc.id)}
                  onRename={() => setRenaming(doc)}
                  onDuplicate={async () => {
                    const { document } = await post<{ document: Snapshot }>(`/api/documents/${doc.id}/duplicate`);
                    toast(`Created "${document.meta.title}".`);
                    void load();
                  }}
                  onTrash={() => void moveToTrash(doc)}
                  onRestore={async () => {
                    await patch(`/api/documents/${doc.id}`, { trashed: false });
                    void load();
                  }}
                  onDelete={async () => {
                    await del(`/api/documents/${doc.id}`);
                    toast(`Deleted "${doc.title}" permanently.`);
                    void load();
                  }}
                />
              ))}
            </div>
          )}
        </section>
      </main>

      {view === "recent" && (
        <button type="button" className="home-fab" aria-label="New document" onClick={() => void create(templates[0]!)} disabled={creating !== null}>
          <Plus size={24} />
        </button>
      )}

      <RenameDialog
        doc={renaming}
        onClose={() => setRenaming(null)}
        onSave={async (title) => {
          if (!renaming) return;
          await patch(`/api/documents/${renaming.id}`, { title });
          setRenaming(null);
          void load();
        }}
      />
    </div>
  );
}

function TemplateThumb({ template }: { template: DocumentTemplate }) {
  const [failed, setFailed] = useState(false);
  if (!template.markdown) {
    return (
      <span className="template-thumb is-blank">
        <FilePlus2 size={26} strokeWidth={1.5} />
      </span>
    );
  }
  if (!failed) {
    return (
      <span className="template-thumb is-image" aria-hidden>
        <ThemedCover light={`/templates/${template.id}.webp`} dark={`/templates/${template.id}.dark.webp`} onError={() => setFailed(true)} />
      </span>
    );
  }
  return <TextCover lines={template.markdown.split("\n")} />;
}

/**
 * A first-page picture for each theme. CSS shows the one for the current
 * theme; the hidden one isn't fetched (lazy images that aren't displayed
 * don't load), and switching theme swaps them at once.
 */
function ThemedCover({ light, dark, onError }: { light: string; dark: string; onError: () => void }) {
  const [darkFailed, setDarkFailed] = useState(false);
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={darkFailed ? undefined : "cover-light"} src={light} alt="" loading="lazy" onError={onError} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {!darkFailed && <img className="cover-dark" src={dark} alt="" loading="lazy" onError={() => setDarkFailed(true)} />}
    </>
  );
}

/** A cover drawn from text, for documents (and templates) without a saved picture of their first page. */
function TextCover({ lines: raw }: { lines: string[] }) {
  const lines = raw.filter((line) => line.trim() && line.trim() !== "&nbsp;" && !line.startsWith("|") && line !== "\\pagebreak").slice(0, 14);
  return (
    <span className="template-thumb" aria-hidden>
      {lines.map((line, index) => {
        const heading = /^#{1,6}\s/.test(line);
        const title = /\{\.title/.test(line);
        const center = /align=center/.test(line);
        const text = line
          .replace(/^#{1,6}\s/, "")
          .replace(/\s*\{[^}]*\}\s*$/, "")
          .replace(/[*_`=]|<br>/g, " ")
          .replace(/^[-\d.]+\s|^- \[ \]\s/, "• ");
        return (
          <span key={index} className={`thumb-line${title ? " is-title" : heading ? " is-heading" : ""}${center ? " is-center" : ""}`}>
            {text}
          </span>
        );
      })}
    </span>
  );
}

function DocumentCard({
  doc,
  trashed,
  onOpen,
  onRename,
  onDuplicate,
  onTrash,
  onRestore,
  onDelete,
}: {
  doc: DocumentMeta;
  trashed: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [broken, setBroken] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const sentences = doc.preview.split(/(?<=[.!?])\s+/);
  return (
    <div className="doc-card" role="button" tabIndex={0} aria-label={doc.title} onClick={() => !trashed && onOpen()} onKeyDown={(event) => event.key === "Enter" && !trashed && onOpen()}>
      <div className="doc-card-cover">
        {doc.thumbnailAt && !broken ? (
          // eslint-disable-next-line @next/next/no-img-element
          <ThemedCover light={`/api/documents/${doc.id}/thumbnail?v=${doc.thumbnailAt}`} dark={`/api/documents/${doc.id}/thumbnail?v=${doc.thumbnailAt}&theme=dark`} onError={() => setBroken(true)} />
        ) : doc.preview ? (
          <TextCover lines={sentences} />
        ) : (
          <span className="template-thumb is-blank" />
        )}
      </div>
      <div className="doc-card-info">
        <span className="doc-card-title">{doc.title}</span>
        <div className="doc-card-meta">
          <FileText size={14} className="doc-card-icon" />
          <span className="doc-card-time" title={`${doc.wordCount.toLocaleString()} words`}>{relativeTime(trashed && doc.trashedAt ? doc.trashedAt : Math.max(doc.updatedAt, doc.lastOpenedAt))}</span>
          <button
            ref={ref}
            type="button"
            className="icon-btn icon-btn-sm doc-card-menu"
            aria-label="Document actions"
            onClick={(event) => {
              event.stopPropagation();
              setMenu(true);
            }}
          >
            <MoreVertical size={16} />
          </button>
        </div>
      </div>
      <Menu
        open={menu}
        onClose={() => setMenu(false)}
        anchor={ref}
        placement="bottom-end"
        items={
          trashed
            ? [
                { label: "Restore", icon: <RotateCcw size={14} />, onSelect: onRestore },
                { kind: "separator" },
                { label: "Delete forever", icon: <Trash2 size={14} />, danger: true, onSelect: onDelete },
              ]
            : [
                { label: "Open", icon: <FileText size={14} />, onSelect: onOpen },
                { label: "Rename", icon: <Pencil size={14} />, onSelect: onRename },
                { label: "Make a copy", icon: <Copy size={14} />, onSelect: onDuplicate },
                { kind: "separator" },
                { label: "Move to trash", icon: <Trash2 size={14} />, danger: true, onSelect: onTrash },
              ]
        }
      />
    </div>
  );
}

function RenameDialog({ doc, onClose, onSave }: { doc: DocumentMeta | null; onClose: () => void; onSave: (title: string) => void }) {
  const [title, setTitle] = useState("");
  useEffect(() => setTitle(doc?.title ?? ""), [doc]);
  return (
    <Dialog
      open={Boolean(doc)}
      onClose={onClose}
      title="Rename document"
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(title)} disabled={!title.trim()}>
            Rename
          </Button>
        </>
      }
    >
      <input
        className="input"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && title.trim() && onSave(title)}
        aria-label="Title"
      />
    </Dialog>
  );
}

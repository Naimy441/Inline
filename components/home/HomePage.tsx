"use client";

import { Download, FilePlus2, FileText, FileUp, FolderOpen, FolderPlus, LayoutGrid, List, Moon, Plus, Search, Sparkles, Sun, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, del, patch, post } from "@/lib/client/api";
import { dismissLegacyDocuments, hasLegacyDocuments, htmlToDocJSON, importLegacyDocuments } from "@/lib/client/legacyImport";
import { useTheme } from "@/lib/client/theme";
import { canMoveFolder, documentFolder, folderPath, summarizeFolders, type Folder, type FolderColor } from "@/lib/doc/folders";
import type { DocumentMeta } from "@/lib/doc/settings";
import { documentTemplates, type DocumentTemplate } from "@/lib/doc/templates";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { AgentStatusBadge } from "@/components/agent/AgentStatusBadge";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { confirmDialog } from "@/components/ui/Confirm";
import { InlineLogo } from "@/components/ui/Logo";
import { TextCover, ThemedCover } from "./covers";
import type { DragItem } from "./dnd";
import { AddDocumentsDialog, FolderDialog, MoveDialog, type MoveTarget } from "./FolderDialogs";
import { dismissGoogleImport, GoogleImportBanner, shouldShowGoogleImport, TakeoutGuide } from "./GoogleImport";
import { ThumbnailQueue, type ThumbnailProgress } from "./thumbnails";
import { Breadcrumbs, FolderCard, FolderGlyph, type FolderActions } from "./folders";
import { DocumentCard, DocumentList, documentTime, type DocumentActions, type Sort } from "./items";

type Snapshot = { meta: DocumentMeta };
type View = "documents" | "recent" | "trash";
type Layout = "grid" | "list";
type FolderDialogState = { mode: "create"; parentId: string | null } | { mode: "edit"; folder: Folder } | null;

const LAYOUT_KEY = "inline-home-layout";
const SORT_KEY = "inline-home-sort";

function readStored<T>(key: string, valid: (value: unknown) => value is T): T | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "null") as unknown;
    return valid(value) ? value : null;
  } catch {
    return null;
  }
}

function store(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing: the choice lasts for this visit.
  }
}

const isLayout = (value: unknown): value is Layout => value === "grid" || value === "list";
const isSort = (value: unknown): value is Sort =>
  Boolean(value) && typeof value === "object" && ["modified", "name", "words"].includes((value as Sort).key) && typeof (value as Sort).descending === "boolean";

/** The folder open on the home page, kept in the address (?folder=…) so Back and links work. */
function folderFromAddress() {
  return new URLSearchParams(window.location.search).get("folder");
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function HomePage() {
  const router = useRouter();
  const [documents, setDocuments] = useState<DocumentMeta[] | null>(null);
  const [trashed, setTrashed] = useState<DocumentMeta[]>([]);
  const [folderList, setFolderList] = useState<Folder[]>([]);
  const [view, setView] = useState<View>("documents");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>("grid");
  const [sort, setSort] = useState<Sort>({ key: "modified", descending: true });
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState<string | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [renaming, setRenaming] = useState<DocumentMeta | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialogState>(null);
  const [moving, setMoving] = useState<MoveTarget | null>(null);
  const [adding, setAdding] = useState<Folder | null>(null);
  const [importing, setImporting] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [googleTip, setGoogleTip] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [previews, setPreviews] = useState<ThumbnailProgress | null>(null);
  const thumbnails = useRef<ThumbnailQueue | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { dark, toggle } = useTheme();
  const templates = useMemo(() => documentTemplates(), []);

  const load = useCallback(async () => {
    try {
      const [live, trash, folderData] = await Promise.all([
        api<{ documents: DocumentMeta[] }>("/api/documents"),
        api<{ documents: DocumentMeta[] }>("/api/documents?trashed=1"),
        api<{ folders: Folder[] }>("/api/folders"),
      ]);
      setDocuments(live.documents);
      setTrashed(trash.documents);
      setFolderList(folderData.folders);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't load documents.", { tone: "error" });
      setDocuments((current) => current ?? []);
    }
  }, []);

  // Documents nobody has opened (imports, ones Claude made) get their first page drawn in the background.
  useEffect(() => {
    const queue = new ThumbnailQueue((id, thumbnailAt) => setDocuments((list) => list?.map((doc) => (doc.id === id ? { ...doc, thumbnailAt } : doc)) ?? list), setPreviews);
    thumbnails.current = queue;
    return () => queue.stop();
  }, []);
  useEffect(() => {
    if (documents) thumbnails.current?.add(documents.filter((doc) => !doc.thumbnailAt).map((doc) => doc.id));
  }, [documents]);

  useEffect(() => {
    void shouldShowGoogleImport().then(setGoogleTip);
  }, []);

  const closeGoogleTip = () => {
    setGoogleTip(false);
    setGuideOpen(false);
    dismissGoogleImport();
  };

  useEffect(() => {
    document.title = "Inline";
    void load();
    setLegacy(hasLegacyDocuments());
    setFolderId(folderFromAddress());
    setLayout(readStored(LAYOUT_KEY, isLayout) ?? "grid");
    setSort(readStored(SORT_KEY, isSort) ?? { key: "modified", descending: true });
    const onPop = () => {
      setFolderId(folderFromAddress());
      setView("documents");
    };
    window.addEventListener("popstate", onPop);
    // Coming back to the tab picks up changes made elsewhere (an editor tab, an MCP client).
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setAgentOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("keydown", onKey);
    };
  }, [load]);

  const folders = useMemo(() => new Map(folderList.map((folder) => [folder.id, folder])), [folderList]);
  const summaries = useMemo(() => summarizeFolders(folders, documents ?? []), [folders, documents]);
  // A folder that no longer exists (deleted elsewhere, an old link) shows the top level.
  const currentId = folderId && folders.has(folderId) ? folderId : null;
  const current = currentId ? folders.get(currentId)! : null;
  const path = useMemo(() => folderPath(folders, currentId), [folders, currentId]);
  const searching = query.trim().length > 0;
  /** Where new documents go: the open folder, when browsing one. */
  const targetFolder = view === "documents" && !searching ? currentId : null;

  const openFolder = useCallback((id: string | null) => {
    setView("documents");
    setQuery("");
    setFolderId(id);
    const url = id ? `/?folder=${encodeURIComponent(id)}` : "/";
    if (window.location.pathname + window.location.search !== url) window.history.pushState(null, "", url);
    window.scrollTo({ top: 0 });
  }, []);

  const changeLayout = (next: Layout) => {
    setLayout(next);
    store(LAYOUT_KEY, next);
  };

  const changeSort = (next: Sort) => {
    setSort(next);
    store(SORT_KEY, next);
  };

  const open = (id: string) => router.push(`/d/${id}`);

  const create = async (template: DocumentTemplate) => {
    setCreating(template.id);
    try {
      const { document } = await post<{ document: Snapshot }>("/api/documents", {
        title: template.documentTitle,
        markdown: template.markdown,
        settings: template.settings,
        folderId: targetFolder,
      });
      const suffix = template.suggestion ? `?ask=${encodeURIComponent(template.suggestion)}` : "";
      router.push(`/d/${document.meta.id}${suffix}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't create the document.", { tone: "error" });
      setCreating(null);
    }
  };

  const uploadForm = (file: File) => {
    const form = new FormData();
    form.append("file", file);
    if (targetFolder) form.append("folderId", targetFolder);
    return form;
  };

  /** Create one document from a file without opening it. Returns its id. */
  const importOne = async (file: File) => {
    if (/\.docx$/i.test(file.name)) {
      const { document } = await api<{ document: Snapshot }>("/api/documents/import", { method: "POST", body: uploadForm(file) });
      return document.meta.id;
    }
    const text = await file.text();
    const title = file.name.replace(/\.[^.]+$/, "") || "Imported document";
    const body = /\.html?$/i.test(file.name) ? { title, doc: htmlToDocJSON(text) } : { title, markdown: text };
    const { document } = await post<{ document: Snapshot }>("/api/documents", { ...body, folderId: targetFolder });
    return document.meta.id;
  };

  /**
   * Import the chosen files. A single document opens straight away; several
   * files, or a ZIP of Word files (such as a Google Takeout export of Google
   * Drive), are all imported and listed.
   */
  const importFiles = async (files: File[]) => {
    if (files.length === 1 && !/\.zip$/i.test(files[0]!.name)) {
      try {
        open(await importOne(files[0]!));
      } catch (error) {
        toast(error instanceof Error ? error.message : "Couldn't import that file.", { tone: "error" });
      }
      return;
    }
    setImporting(true);
    let imported = 0;
    let fromArchives = 0;
    let folderCount = 0;
    const failed: string[] = [];
    for (const file of files) {
      try {
        if (/\.zip$/i.test(file.name)) {
          const result = await api<{ documents: DocumentMeta[]; failed: { name: string }[]; folders?: number }>("/api/documents/import", { method: "POST", body: uploadForm(file) });
          imported += result.documents.length;
          fromArchives += result.documents.length;
          folderCount += result.folders ?? 0;
          failed.push(...result.failed.map((item) => item.name.slice(item.name.lastIndexOf("/") + 1)));
        } else {
          await importOne(file);
          imported += 1;
        }
      } catch (error) {
        if (files.length === 1) {
          toast(error instanceof Error ? error.message : "Couldn't import that file.", { tone: "error" });
          setImporting(false);
          return;
        }
        failed.push(file.name);
      }
    }
    setImporting(false);
    void load();
    // The Google Docs tip has done its job once an archive came in.
    if (fromArchives && googleTip) closeGoogleTip();
    else setGuideOpen(false);
    const where = folderCount ? ` in ${plural(folderCount, "folder")}` : targetFolder && current ? ` into "${current.name}"` : "";
    const summary = `Imported ${plural(imported, "document")}${where}.`;
    if (!failed.length) toast(summary, { tone: "success" });
    else toast(`${summary} Couldn't read ${failed.length === 1 ? failed[0] : `${failed.length} files`}.`, { tone: imported ? "info" : "error", duration: 8000 });
  };

  const runLegacyImport = async () => {
    try {
      const count = await importLegacyDocuments();
      setLegacy(false);
      toast(`Imported ${plural(count, "document")} from the previous version.`, { tone: "success" });
      void load();
    } catch {
      toast("Couldn't import your earlier documents.", { tone: "error" });
    }
  };

  // --- moving ---------------------------------------------------------------

  const folderName = useCallback((id: string | null) => (id ? (folders.get(id)?.name ?? "folder") : "All documents"), [folders]);

  const moveDocuments = async (ids: string[], target: string | null, options: { undo?: boolean } = {}) => {
    const docs = (documents ?? []).filter((doc) => ids.includes(doc.id));
    const previous = new Map(docs.map((doc) => [doc.id, documentFolder(folders, doc)]));
    // Show the move at once; the list reloads from the server after.
    setDocuments((list) => list?.map((doc) => (ids.includes(doc.id) ? { ...doc, folderId: target ?? undefined } : doc)) ?? list);
    try {
      await Promise.all(ids.map((id) => patch(`/api/documents/${id}`, { folderId: target })));
      if (options.undo !== false) {
        toast(docs.length === 1 ? `Moved "${docs[0]!.title}" to ${folderName(target)}.` : `Moved ${plural(docs.length, "document")} to ${folderName(target)}.`, {
          tone: "success",
          action: {
            label: "Undo",
            run: () => void Promise.all([...previous].map(([id, folder]) => patch(`/api/documents/${id}`, { folderId: folder }))).then(load),
          },
        });
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't move that.", { tone: "error" });
    }
    void load();
  };

  const moveFolder = async (folder: Folder, target: string | null) => {
    try {
      await patch(`/api/folders/${folder.id}`, { parentId: target });
      toast(`Moved "${folder.name}" to ${folderName(target)}.`, {
        tone: "success",
        action: { label: "Undo", run: () => void patch(`/api/folders/${folder.id}`, { parentId: folder.parentId }).then(load) },
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't move that folder.", { tone: "error" });
    }
    void load();
  };

  const createFolder = async (name: string, color: FolderColor, parentId: string | null) => {
    try {
      const { folder } = await post<{ folder: Folder }>("/api/folders", { name, color, parentId });
      setFolderList((list) => [...list, folder]);
      return folder;
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't create the folder.", { tone: "error" });
      return null;
    }
  };

  const updateFolder = async (folder: Folder, change: { name?: string; color?: FolderColor }) => {
    setFolderList((list) => list.map((item) => (item.id === folder.id ? { ...item, ...change } : item)));
    try {
      await patch(`/api/folders/${folder.id}`, change);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't change the folder.", { tone: "error" });
    }
    void load();
  };

  const deleteFolder = async (folder: Folder) => {
    const summary = summaries.get(folder.id);
    const inside = [summary?.documents.length ? plural(summary.documents.length, "document") : "", summary?.folders ? plural(summary.folders, "folder") : ""].filter(Boolean).join(" and ");
    const ok = await confirmDialog({
      title: `Delete "${folder.name}"?`,
      body: inside ? `The ${inside} inside move to ${folderName(folder.parentId)}. No documents are deleted.` : "The folder is empty.",
      confirmLabel: "Delete folder",
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/api/folders/${folder.id}`);
      toast(`Deleted the folder "${folder.name}".`);
      if (currentId && folderPath(folders, currentId).some((item) => item.id === folder.id)) openFolder(folder.parentId);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't delete the folder.", { tone: "error" });
    }
    void load();
  };

  const folderActions: FolderActions = {
    open: openFolder,
    rename: (folder) => setFolderDialog({ mode: "edit", folder }),
    recolor: (folder, color) => void updateFolder(folder, { color }),
    newFolder: (parentId) => setFolderDialog({ mode: "create", parentId }),
    move: (folder) => setMoving({ kind: "folder", id: folder.id, title: folder.name, from: folder.parentId }),
    remove: (folder) => void deleteFolder(folder),
    canDrop: (target: string | null, item: DragItem) => {
      if (item.kind === "folder") return item.id !== target && folders.get(item.id)?.parentId !== target && canMoveFolder(folders, item.id, target);
      const doc = documents?.find((entry) => entry.id === item.id);
      return Boolean(doc) && documentFolder(folders, doc!) !== target;
    },
    drop: (target, item) => {
      if (item.kind === "document") void moveDocuments([item.id], target);
      else {
        const folder = folders.get(item.id);
        if (folder) void moveFolder(folder, target);
      }
    },
  };

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

  const documentActions: DocumentActions = {
    open: (doc) => open(doc.id),
    rename: (doc) => setRenaming(doc),
    duplicate: async (doc) => {
      const { document } = await post<{ document: Snapshot }>(`/api/documents/${doc.id}/duplicate`);
      toast(`Created "${document.meta.title}".`);
      void load();
    },
    move: (doc) => setMoving({ kind: "document", id: doc.id, title: doc.title, from: documentFolder(folders, doc) }),
    trash: (doc) => void moveToTrash(doc),
    restore: async (doc) => {
      await patch(`/api/documents/${doc.id}`, { trashed: false });
      void load();
    },
    deleteForever: async (doc) => {
      await del(`/api/documents/${doc.id}`);
      toast(`Deleted "${doc.title}" permanently.`);
      void load();
    },
  };

  // --- what's shown ---------------------------------------------------------

  const { shownFolders, shownDocs } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    const direction = sort.descending ? -1 : 1;
    const sortDocs = (list: DocumentMeta[]) =>
      [...list].sort((a, b) => {
        if (sort.key === "name") return direction * byName(a.title, b.title);
        if (sort.key === "words") return direction * (a.wordCount - b.wordCount);
        return direction * (documentTime(a, view === "trash") - documentTime(b, view === "trash"));
      });
    const sortFolders = (list: Folder[]) =>
      [...list].sort((a, b) => {
        if (sort.key === "modified") return direction * ((summaries.get(a.id)?.updatedAt ?? a.updatedAt) - (summaries.get(b.id)?.updatedAt ?? b.updatedAt));
        if (sort.key === "words") {
          const words = (folder: Folder) => summaries.get(folder.id)?.documents.reduce((total, doc) => total + doc.wordCount, 0) ?? 0;
          return direction * (words(a) - words(b));
        }
        return (sort.key === "name" ? direction : 1) * byName(a.name, b.name);
      });
    const matches = (doc: DocumentMeta) => doc.title.toLowerCase().includes(q) || doc.preview.toLowerCase().includes(q);
    if (view === "trash") return { shownFolders: [], shownDocs: sortDocs(q ? trashed.filter(matches) : trashed) };
    const all = documents ?? [];
    if (q) return { shownFolders: view === "documents" ? sortFolders(folderList.filter((folder) => folder.name.toLowerCase().includes(q))) : [], shownDocs: sortDocs(all.filter(matches)) };
    if (view === "recent") return { shownFolders: [], shownDocs: sortDocs(all) };
    return {
      shownFolders: sortFolders(folderList.filter((folder) => folder.parentId === currentId)),
      shownDocs: sortDocs(all.filter((doc) => documentFolder(folders, doc) === currentId)),
    };
  }, [documents, trashed, folderList, folders, summaries, view, query, sort, currentId]);

  const showLocation = searching || view === "recent";
  const closeFolderDialog = useCallback(() => setFolderDialog(null), []);
  const closeMove = useCallback(() => setMoving(null), []);
  const closeAdd = useCallback(() => setAdding(null), []);
  const closeRename = useCallback(() => setRenaming(null), []);
  const folderDialogInitial = useMemo(
    () => (folderDialog?.mode === "edit" ? { name: folderDialog.folder.name, color: folderDialog.folder.color } : { name: "", color: (folderDialog?.parentId && folders.get(folderDialog.parentId)?.color) || ("gray" as FolderColor) }),
    [folderDialog, folders],
  );

  const grid = (
    <div className="doc-grid">
      {shownFolders.map((folder) => (
        <FolderCard key={folder.id} folder={folder} summary={summaries.get(folder.id)} actions={folderActions} />
      ))}
      {shownDocs.map((doc) => (
        <DocumentCard key={doc.id} doc={doc} trashed={view === "trash"} folders={folders} showLocation={showLocation} actions={documentActions} />
      ))}
    </div>
  );

  return (
    <div className={`home${agentOpen ? " has-agent" : ""}`}>
      <header className="home-header">
        <div className="home-brand">
          <InlineLogo />
          <span>Inline</span>
        </div>
        <div className="home-search">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={view === "trash" ? "Search the trash" : "Search documents and folders"} aria-label="Search documents" />
          {query && (
            <button type="button" className="home-search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
              <X size={14} />
            </button>
          )}
        </div>
        <div className="home-header-actions">
          <AgentStatusBadge />
          <IconButton label="Claude" shortcut="⌘J" active={agentOpen} onClick={() => setAgentOpen((open) => !open)}>
            <Sparkles size={16} />
          </IconButton>
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

        {googleTip && <GoogleImportBanner onShowGuide={() => setGuideOpen(true)} onDismiss={closeGoogleTip} />}

        <section className="home-section">
          <div className="home-section-head">
            <h2>
              Start something new
              {targetFolder && current && (
                <span className="home-target">
                  <FolderGlyph color={current.color} size={13} /> saves to {current.name}
                </span>
              )}
            </h2>
            <Button size="sm" variant="ghost" icon={<FileUp size={15} />} loading={importing} onClick={() => fileInput.current?.click()} title="Word, Markdown, HTML or text files, or a ZIP of Word files such as a Google Takeout export">
              {importing ? "Importing…" : "Import files"}
            </Button>
            <Button size="sm" variant="ghost" icon={<Download size={15} />} onClick={() => window.location.assign("/api/documents/backup")}>
              Download all
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".docx,.zip,.md,.markdown,.txt,.html,.htm"
              multiple
              hidden
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                if (files.length) void importFiles(files);
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
          <div className="home-section-head home-toolbar">
            <div className="segmented" role="tablist">
              {(
                [
                  ["documents", "Documents"],
                  ["recent", "Recent"],
                  ["trash", `Trash${trashed.length ? ` (${trashed.length})` : ""}`],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={view === id} className={view === id ? "is-active" : ""} onClick={() => setView(id)}>
                  {label}
                </button>
              ))}
            </div>
            <span className="home-spacer" />
            {previews && (
              <span className="home-progress" role="status" aria-live="polite">
                <span className="spinner" aria-hidden />
                Drawing previews {Math.min(previews.done + 1, previews.total)} of {previews.total}
              </span>
            )}
            {view !== "trash" && (documents?.length ?? 0) > 0 && (
              <Button size="sm" variant="ghost" icon={<Sparkles size={15} />} className="organize-button" onClick={() => setAgentOpen(true)} title="Ask Claude to sort your documents into folders">
                Organize with Claude
              </Button>
            )}
            {view === "documents" && (
              <Button size="sm" variant="ghost" icon={<FolderPlus size={15} />} onClick={() => setFolderDialog({ mode: "create", parentId: currentId })}>
                New folder
              </Button>
            )}
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
                    toast(`Deleted ${plural(deleted, "document")} permanently.`);
                  } catch (error) {
                    toast(error instanceof Error ? error.message : "Couldn't empty the trash.", { tone: "error" });
                  }
                  void load();
                }}
              >
                Empty trash
              </Button>
            )}
            <div className="segmented layout-toggle" role="group" aria-label="Layout">
              <button type="button" aria-label="Grid view" title="Grid view" aria-pressed={layout === "grid"} className={layout === "grid" ? "is-active" : ""} onClick={() => changeLayout("grid")}>
                <LayoutGrid size={15} />
              </button>
              <button type="button" aria-label="List view" title="List view" aria-pressed={layout === "list"} className={layout === "list" ? "is-active" : ""} onClick={() => changeLayout("list")}>
                <List size={15} />
              </button>
            </div>
          </div>

          {view === "documents" && !searching && (
            <div className="home-location">
              <Breadcrumbs path={path} actions={folderActions} />
              {current && (
                <Button size="sm" variant="ghost" icon={<Plus size={15} />} onClick={() => setAdding(current)}>
                  Add documents
                </Button>
              )}
            </div>
          )}
          {searching && (
            <p className="home-note">
              {shownFolders.length + shownDocs.length ? `${plural(shownFolders.length + shownDocs.length, "result")} for "${query.trim()}"` : ""}
              {view === "trash" ? " in the trash" : ""}
            </p>
          )}
          {view === "trash" && !searching && <p className="home-note">Documents in the trash are deleted forever after 30 days.</p>}

          {documents === null ? (
            <div className="doc-grid">
              {[0, 1, 2, 3].map((key) => (
                <div key={key} className="doc-card skeleton">
                  <div className="doc-card-cover" />
                </div>
              ))}
            </div>
          ) : shownFolders.length + shownDocs.length === 0 ? (
            <div className="home-empty">
              {view === "trash" && !searching ? (
                "Trash is empty."
              ) : searching ? (
                `Nothing matches "${query.trim()}".`
              ) : current ? (
                <>
                  <FolderOpen size={30} strokeWidth={1.5} />
                  <p>
                    <strong>{current.name}</strong> is empty. Drag documents here, add ones you already have, or start one from a template above.
                  </p>
                  <Button size="sm" variant="secondary" icon={<Plus size={15} />} onClick={() => setAdding(current)}>
                    Add documents
                  </Button>
                </>
              ) : (
                <>
                  <FileText size={28} />
                  <p>No documents yet. Pick a template above to start, then ask Claude to help you write.</p>
                </>
              )}
            </div>
          ) : layout === "list" ? (
            <DocumentList folderRows={shownFolders} docs={shownDocs} folders={folders} summaries={summaries} trashed={view === "trash"} showLocation={showLocation} sort={sort} onSort={changeSort} folderActions={folderActions} documentActions={documentActions} />
          ) : shownFolders.length && shownDocs.length ? (
            <>
              <h3 className="home-subhead">Folders</h3>
              <div className="doc-grid">
                {shownFolders.map((folder) => (
                  <FolderCard key={folder.id} folder={folder} summary={summaries.get(folder.id)} actions={folderActions} />
                ))}
              </div>
              <h3 className="home-subhead">Documents</h3>
              <div className="doc-grid">
                {shownDocs.map((doc) => (
                  <DocumentCard key={doc.id} doc={doc} trashed={view === "trash"} folders={folders} showLocation={showLocation} actions={documentActions} />
                ))}
              </div>
            </>
          ) : (
            grid
          )}
        </section>
      </main>

      {view !== "trash" && (
        <button type="button" className="home-fab" aria-label="New document" onClick={() => void create(templates[0]!)} disabled={creating !== null}>
          <Plus size={24} />
        </button>
      )}

      {agentOpen && (
        <div className="home-agent">
          <AgentPanel documentId={null} home={{ folderId: currentId }} onClose={() => setAgentOpen(false)} onLibraryChange={() => void load()} />
        </div>
      )}

      <TakeoutGuide open={guideOpen} importing={importing} onClose={() => setGuideOpen(false)} onImport={() => fileInput.current?.click()} />

      <RenameDialog
        doc={renaming}
        onClose={closeRename}
        onSave={async (title) => {
          if (!renaming) return;
          await patch(`/api/documents/${renaming.id}`, { title });
          setRenaming(null);
          void load();
        }}
      />
      <FolderDialog
        open={folderDialog !== null}
        title={folderDialog?.mode === "edit" ? "Rename folder" : folderDialog?.parentId ? `New folder in "${folderName(folderDialog.parentId)}"` : "New folder"}
        confirmLabel={folderDialog?.mode === "edit" ? "Save" : "Create"}
        initial={folderDialogInitial}
        onClose={closeFolderDialog}
        onSave={async (name, color) => {
          const state = folderDialog;
          setFolderDialog(null);
          if (state?.mode === "edit") void updateFolder(state.folder, { name, color });
          else if (state) {
            const folder = await createFolder(name, color, state.parentId);
            if (folder) toast(`Created the folder "${folder.name}".`, { tone: "success", action: { label: "Open", run: () => openFolder(folder.id) } });
          }
        }}
      />
      <MoveDialog
        item={moving}
        folders={folderList}
        onClose={closeMove}
        onCreateFolder={(name, parentId) => createFolder(name, parentId ? (folders.get(parentId)?.color ?? "gray") : "gray", parentId)}
        onMove={(target) => {
          const item = moving;
          setMoving(null);
          if (!item) return;
          if (item.kind === "document") void moveDocuments([item.id], target);
          else {
            const folder = folders.get(item.id);
            if (folder) void moveFolder(folder, target);
          }
        }}
      />
      <AddDocumentsDialog
        folder={adding}
        documents={documents ?? []}
        folders={folders}
        onClose={closeAdd}
        onAdd={(ids) => {
          const folder = adding;
          setAdding(null);
          if (folder) void moveDocuments(ids, folder.id);
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

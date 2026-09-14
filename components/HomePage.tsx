"use client";

import { useEffect, useMemo, useState } from "react";
import { MdArrowBack, MdDarkMode, MdDeleteOutline, MdDescription, MdGridView, MdLightMode, MdMoreVert, MdOpenInNew, MdSearch, MdViewList } from "react-icons/md";
import { InlineMark } from "@/components/InlineMark";
import { PageThumb, thumbFromDocument, thumbFromTemplate } from "@/components/PageThumb";
import { documentTemplates } from "@/lib/documentTemplates";
import { clearChats } from "@/lib/agent/chats";
import { createDocument, listDocuments, purgeDocument, renameDocument, restoreDocument, trashDocument, type StoredDocument } from "@/lib/documentStore";
import { useInlineTheme } from "@/lib/theme";

type Props = {
  onOpenDocument: (id: string) => void;
};

export function HomePage({ onOpenDocument }: Props) {
  const templates = useMemo(() => documentTemplates(), []);
  const { darkMode, toggleTheme } = useInlineTheme();
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<StoredDocument | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [trashTarget, setTrashTarget] = useState<StoredDocument | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<StoredDocument | null>(null);
  const [library, setLibrary] = useState<"recent" | "trash">("recent");

  const refresh = () => setDocuments(listDocuments({ includeTrashed: true }));

  useEffect(() => {
    refresh();
    const storedView = window.localStorage.getItem("inline-home-view");
    if (storedView === "grid" || storedView === "list") setView(storedView);
    const onStorage = () => refresh();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("inline-home-view", view);
  }, [view]);

  const recentDocuments = useMemo(() => documents.filter((document) => !document.deletedAt), [documents]);
  const trashedDocuments = useMemo(
    () => documents.filter((document) => document.deletedAt).sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)),
    [documents],
  );
  const libraryDocuments = library === "trash" ? trashedDocuments : recentDocuments;
  const filteredDocuments = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return libraryDocuments;
    return libraryDocuments.filter((document) => `${document.title} ${plainPreview(document.html)}`.toLowerCase().includes(normalized));
  }, [libraryDocuments, query]);

  const openTemplate = (id: string) => {
    const template = templates.find((item) => item.id === id);
    if (!template) return;
    const document = createDocument({
      title: template.id === "blank" ? "Untitled document" : template.title,
      html: template.html,
      headerText: template.headerText,
      footerText: template.footerText,
      showHeader: template.showHeader,
      showFooter: template.showFooter,
      showPageNumbers: template.showPageNumbers,
      pageNumberLocation: template.pageNumberLocation,
      headerAlign: template.headerAlign,
      footerAlign: template.footerAlign,
      fontFamily: template.fontFamily,
      fontSize: template.fontSize,
      lineSpacing: template.lineSpacing,
      pageLayout: template.pageLayout,
    });
    window.location.assign(`/?doc=${encodeURIComponent(document.id)}`);
  };

  const startRename = (document: StoredDocument) => {
    setMenuId(null);
    setRenameTarget(document);
    setRenameValue(document.title);
  };

  const submitRename = () => {
    if (!renameTarget || !renameValue.trim()) return;
    renameDocument(renameTarget.id, renameValue);
    setRenameTarget(null);
    refresh();
  };

  const askRemove = (document: StoredDocument) => {
    setMenuId(null);
    setTrashTarget(document);
  };

  const confirmRemove = () => {
    if (!trashTarget) return;
    trashDocument(trashTarget.id);
    setTrashTarget(null);
    refresh();
  };

  const askPurge = (document: StoredDocument) => {
    setMenuId(null);
    setPurgeTarget(document);
  };

  const confirmPurge = () => {
    if (!purgeTarget) return;
    purgeDocument(purgeTarget.id);
    clearChats(purgeTarget.id);
    setPurgeTarget(null);
    refresh();
  };

  const restore = (document: StoredDocument) => {
    setMenuId(null);
    restoreDocument(document.id);
    refresh();
  };

  const openDocument = (document: StoredDocument) => {
    if (document.deletedAt) restoreDocument(document.id);
    onOpenDocument(document.id);
  };

  const showRecents = () => {
    setMenuId(null);
    setLibrary("recent");
  };

  const showTrash = () => {
    setMenuId(null);
    setLibrary("trash");
  };

  useEffect(() => {
    if (!renameTarget && !trashTarget && !purgeTarget) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setRenameTarget(null);
      setTrashTarget(null);
      setPurgeTarget(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [renameTarget, trashTarget, purgeTarget]);

  return (
    <div className="home-shell" onClick={() => setMenuId(null)}>
      <header className="home-header">
        <a
          className="home-brand"
          href="/"
          aria-label="Inline home"
          onClick={(event) => {
            if (library !== "trash") return;
            event.preventDefault();
            showRecents();
          }}
        >
          <InlineMark />
          <span>Inline</span>
        </a>
        <label className="home-search">
          <MdSearch aria-hidden="true" />
          <input
            type="search"
            aria-label="Search documents"
            placeholder="Search documents"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onClick={(event) => event.stopPropagation()}
          />
        </label>
        <div className="home-header-actions">
          <button
            className={`home-icon-button${library === "trash" ? " is-active" : ""}`}
            type="button"
            aria-label={trashedDocuments.length ? `Trash, ${trashedDocuments.length} items` : "Trash"}
            title="Trash"
            aria-current={library === "trash" ? "page" : undefined}
            onClick={(event) => {
              event.stopPropagation();
              showTrash();
            }}
          >
            <MdDeleteOutline aria-hidden="true" />
            {trashedDocuments.length > 0 && (
              <span className="home-trash-count">{trashedDocuments.length > 9 ? "9+" : trashedDocuments.length}</span>
            )}
          </button>
          <button
            className="home-icon-button home-theme-toggle"
            type="button"
            aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
            title={darkMode ? "Light mode" : "Dark mode"}
            onClick={(event) => {
              event.stopPropagation();
              toggleTheme();
            }}
          >
            <MdDarkMode className="theme-icon-light" aria-hidden="true" />
            <MdLightMode className="theme-icon-dark" aria-hidden="true" />
          </button>
          <span className="home-account" aria-hidden="true">N</span>
        </div>
      </header>

      {library === "recent" && (
        <section className="template-section" aria-labelledby="new-document-heading">
          <div className="home-band">
            <div className="home-section-heading">
              <h1 id="new-document-heading">Start a new document</h1>
            </div>
            <div className="template-grid">
              {templates.map((template) => (
                <button className="template-card" type="button" key={template.id} onClick={() => openTemplate(template.id)}>
                  <PageThumb source={thumbFromTemplate(template)} blank={template.id === "blank"} />
                  <span className="template-card-copy">
                    <strong>{template.title}</strong>
                    <small>{template.description}</small>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="recent-section" aria-labelledby="recent-documents-heading">
        <div className="home-band">
          <div className="home-section-heading recent-heading">
            <div className="home-library-title">
              {library === "trash" && (
                <button className="home-back" type="button" aria-label="Back to recent documents" onClick={showRecents}>
                  <MdArrowBack aria-hidden="true" />
                </button>
              )}
              <div>
                <h2 id="recent-documents-heading">{library === "trash" ? "Trash" : "Recent documents"}</h2>
                <p>
                  {query
                    ? `${filteredDocuments.length} matching document${filteredDocuments.length === 1 ? "" : "s"}`
                    : library === "trash"
                      ? trashedDocuments.length
                        ? "Restore a document or delete it forever"
                        : "Nothing in trash"
                      : "Opened on this device"}
                </p>
              </div>
            </div>
            <div className="recent-controls" aria-label="Document view options">
              <button className={view === "grid" ? "is-active" : ""} type="button" aria-label="Grid view" aria-pressed={view === "grid"} onClick={() => setView("grid")}>
                <MdGridView />
              </button>
              <button className={view === "list" ? "is-active" : ""} type="button" aria-label="List view" aria-pressed={view === "list"} onClick={() => setView("list")}>
                <MdViewList />
              </button>
            </div>
          </div>

          {filteredDocuments.length ? (
            <div className={`recent-documents recent-documents-${view}`}>
              {filteredDocuments.map((document) => (
                <article className="recent-card" key={document.id}>
                  <a className="recent-card-open" href={`/?doc=${encodeURIComponent(document.id)}`} onClick={(event) => { event.preventDefault(); openDocument(document); }}>
                    <span className="recent-thumbnail">
                      <PageThumb source={thumbFromDocument(document)} fill={view === "grid"} width={view === "list" ? 72 : 128} />
                    </span>
                  </a>
                  <div className="recent-card-meta">
                    <a className="recent-card-info" href={`/?doc=${encodeURIComponent(document.id)}`} onClick={(event) => { event.preventDefault(); openDocument(document); }}>
                      <strong>{document.title}</strong>
                      <small>
                        {library === "trash"
                          ? `Trashed ${relativeDate(document.deletedAt ?? document.updatedAt)}`
                          : `Opened ${relativeDate(document.lastOpenedAt)}`}
                      </small>
                    </a>
                    <button
                      className="recent-card-menu-button"
                      type="button"
                      aria-label={`Actions for ${document.title}`}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setMenuId((current) => (current === document.id ? null : document.id));
                      }}
                    >
                      <MdMoreVert />
                    </button>
                    {menuId === document.id && (
                      <div className="recent-card-menu" onClick={(event) => event.stopPropagation()}>
                        {library === "trash" ? (
                          <>
                            <button type="button" onClick={() => restore(document)}>Restore</button>
                            <button type="button" onClick={() => openDocument(document)}>Open</button>
                            <button type="button" className="is-danger" onClick={() => askPurge(document)}>Delete forever</button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => openDocument(document)}>Open</button>
                            <button type="button" onClick={() => startRename(document)}>Rename</button>
                            <button type="button" onClick={() => window.open(`/?doc=${encodeURIComponent(document.id)}`, "_blank", "noopener,noreferrer")}>
                              <MdOpenInNew />
                              Open in new tab
                            </button>
                            <button type="button" className="is-danger" onClick={() => askRemove(document)}>Remove</button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="home-empty-state">
              <span className="home-empty-icon">{library === "trash" ? <MdDeleteOutline /> : <MdDescription />}</span>
              <strong>
                {query ? "No documents found" : library === "trash" ? "Trash is empty" : "No recent documents"}
              </strong>
              <p>
                {query
                  ? "Try another search."
                  : library === "trash"
                    ? "Documents you remove will show up here."
                    : "Create a document from a template above."}
              </p>
            </div>
          )}
        </div>
      </section>

      {renameTarget && (
        <div className="home-dialog-backdrop" role="presentation" onMouseDown={() => setRenameTarget(null)}>
          <form
            className="home-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-document-heading"
            onSubmit={(event) => {
              event.preventDefault();
              submitRename();
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="rename-document-heading">Rename document</h2>
            <input autoFocus value={renameValue} aria-label="New document name" onChange={(event) => setRenameValue(event.target.value)} />
            <div className="home-dialog-actions">
              <button type="button" onClick={() => setRenameTarget(null)}>Cancel</button>
              <button type="submit" className="home-primary-button">Save</button>
            </div>
          </form>
        </div>
      )}

      {trashTarget && (
        <div className="home-dialog-backdrop" role="presentation" onMouseDown={() => setTrashTarget(null)}>
          <div
            className="home-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="trash-document-heading"
            aria-describedby="trash-document-copy"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="trash-document-heading">Move to trash?</h2>
            <p id="trash-document-copy">
              “{trashTarget.title || "Untitled document"}” will be moved to trash.
            </p>
            <div className="home-dialog-actions">
              <button type="button" autoFocus onClick={() => setTrashTarget(null)}>
                Cancel
              </button>
              <button type="button" className="home-danger-button" onClick={confirmRemove}>
                Move to trash
              </button>
            </div>
          </div>
        </div>
      )}

      {purgeTarget && (
        <div className="home-dialog-backdrop" role="presentation" onMouseDown={() => setPurgeTarget(null)}>
          <div
            className="home-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="purge-document-heading"
            aria-describedby="purge-document-copy"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="purge-document-heading">Delete forever?</h2>
            <p id="purge-document-copy">
              “{purgeTarget.title || "Untitled document"}” will be permanently deleted. This cannot be undone.
            </p>
            <div className="home-dialog-actions">
              <button type="button" autoFocus onClick={() => setPurgeTarget(null)}>
                Cancel
              </button>
              <button type="button" className="home-danger-button" onClick={confirmPurge}>
                Delete forever
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function plainPreview(html: string) {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/div>|<\/p>|<\/h[1-6]>|<\/li>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
}

function relativeDate(timestamp: number) {
  const diff = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

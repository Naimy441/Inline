"use client";

import { FileText } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import type { LinkedDocument } from "@/lib/agent/types";
import { api } from "@/lib/client/api";

type DocChoice = { id: string; title: string };
type PagePreview = { number: number; words: number; preview: string };

/**
 * Link another document for this message: specific pages as a writing sample,
 * or the whole document as context.
 */
export function LinkDocumentDialog({
  open,
  excludeId,
  onClose,
  onLink,
}: {
  open: boolean;
  /** The document already open, which is left out of the list. */
  excludeId: string | null;
  onClose: () => void;
  onLink: (link: LinkedDocument) => void;
}) {
  const [documents, setDocuments] = useState<DocChoice[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<LinkedDocument["purpose"]>("context");
  const [pages, setPages] = useState<PagePreview[] | null>(null);
  const [measured, setMeasured] = useState(true);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [loadingPages, setLoadingPages] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setQuery("");
    setSelectedId(null);
    setPurpose("context");
    setPages(null);
    setChecked(new Set());
    setError(null);
    setLoadingDocs(true);
    api<{ documents: Array<{ id: string; title: string }> }>("/api/documents")
      .then(({ documents: list }) => {
        if (!live) return;
        setDocuments(list.filter((doc) => doc.id !== excludeId).map((doc) => ({ id: doc.id, title: doc.title || "Untitled" })));
      })
      .catch(() => live && setError("Couldn't load your documents."))
      .finally(() => live && setLoadingDocs(false));
    return () => {
      live = false;
    };
  }, [open, excludeId]);

  useEffect(() => {
    if (!selectedId) return;
    let live = true;
    setPages(null);
    setChecked(new Set());
    setLoadingPages(true);
    api<{ measured: boolean; pages: PagePreview[] }>(`/api/documents/${selectedId}/pages`)
      .then((result) => {
        if (!live) return;
        setMeasured(result.measured);
        setPages(result.pages);
      })
      .catch(() => live && setError("Couldn't read that document's pages."))
      .finally(() => live && setLoadingPages(false));
    return () => {
      live = false;
    };
  }, [selectedId]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return documents;
    return documents.filter((doc) => doc.title.toLowerCase().includes(needle));
  }, [documents, query]);
  const selected = documents.find((doc) => doc.id === selectedId) ?? null;
  const allChecked = Boolean(pages?.length && pages.every((page) => checked.has(page.number)));
  const canLink = Boolean(selected) && (purpose === "context" || checked.size > 0) && !(purpose === "voice" && loadingPages);

  const confirm = () => {
    if (!selected || !canLink) return;
    const pagesChosen = [...checked].sort((a, b) => a - b);
    onLink({ id: selected.id, title: selected.title, purpose, ...(purpose === "voice" ? { pages: pagesChosen } : {}) });
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Link a document"
      description="Match the voice of specific pages, or include a whole document as context."
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canLink} onClick={confirm}>
            Link document
          </Button>
        </>
      }
    >
      <input
        className="input link-doc-search"
        type="search"
        autoFocus
        value={query}
        placeholder="Search documents"
        aria-label="Search documents"
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="link-doc-list" role="listbox" aria-label="Documents">
        {loadingDocs ? (
          <p className="link-note">Loading documents…</p>
        ) : shown.length === 0 ? (
          <p className="link-note">{documents.length === 0 ? "No other documents yet." : "No documents match."}</p>
        ) : (
          shown.map((doc) => (
            <button
              key={doc.id}
              type="button"
              role="option"
              aria-selected={doc.id === selectedId}
              className={`link-doc-item${doc.id === selectedId ? " is-selected" : ""}`}
              onClick={() => {
                setSelectedId(doc.id);
                setPurpose("context");
                setError(null);
              }}
            >
              <FileText size={14} />
              <span>{doc.title}</span>
            </button>
          ))
        )}
      </div>
      {selected && (
        <div className="link-purpose" role="radiogroup" aria-label="How Claude should use it">
          <label className={purpose === "voice" ? "is-selected" : ""}>
            <input type="radio" name="link-purpose" checked={purpose === "voice"} onChange={() => setPurpose("voice")} />
            <span className="link-purpose-name">Match the voice</span>
            <span className="link-purpose-hint">Use the pages you choose as a writing sample.</span>
          </label>
          <label className={purpose === "context" ? "is-selected" : ""}>
            <input type="radio" name="link-purpose" checked={purpose === "context"} onChange={() => setPurpose("context")} />
            <span className="link-purpose-name">Use as context</span>
            <span className="link-purpose-hint">Include the whole document because its information matters.</span>
          </label>
        </div>
      )}
      {selected && purpose === "voice" && (
        <div className="link-pages">
          <div className="link-pages-head">
            <span>Pages</span>
            {pages && pages.length > 1 && (
              <button
                type="button"
                className="link-text-btn"
                onClick={() => setChecked(allChecked ? new Set() : new Set(pages.map((page) => page.number)))}
              >
                {allChecked ? "Clear" : "Select all"}
              </button>
            )}
          </div>
          {loadingPages ? (
            <p className="link-note">Reading pages…</p>
          ) : (
            pages?.map((page) => (
              <label key={page.number} className="link-page">
                <input
                  type="checkbox"
                  checked={checked.has(page.number)}
                  aria-label={`Page ${page.number}`}
                  onChange={() =>
                    setChecked((current) => {
                      const next = new Set(current);
                      if (next.has(page.number)) next.delete(page.number);
                      else next.add(page.number);
                      return next;
                    })
                  }
                />
                <span>
                  <span className="link-page-name">Page {page.number}</span>
                  <span className="link-page-preview">{page.preview}</span>
                </span>
              </label>
            ))
          )}
          {pages && !measured && <p className="link-note">Page breaks are exact. Other pages are estimated from the document's length.</p>}
          {pages && !checked.size && !loadingPages && <p className="link-note">Choose at least one page. The rest of the document is left out.</p>}
        </div>
      )}
      {error && <p className="link-note link-note-error">{error}</p>}
    </Dialog>
  );
}

"use client";

import { FileText, House, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { ChatSummary } from "@/lib/agent/types";
import { api } from "@/lib/client/api";
import { chatApi } from "@/lib/client/chatSession";
import { useIsPhone } from "@/lib/client/viewport";
import type { DocumentMeta } from "@/lib/doc/settings";
import { Popover } from "@/components/ui/Popover";

function relativeTime(at: number) {
  const diff = Date.now() - at;
  const minute = 60_000;
  if (diff < minute) return "Just now";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} min ago`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Searchable list of earlier chats: this document's by default, or every
 * document's, each labelled with the document it belongs to. Picking a chat
 * from another document opens that document with the chat.
 */
export function ChatHistory({
  open,
  onClose,
  anchor,
  documentId,
  currentChatId,
  onOpenChat,
  onOpenElsewhere,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  /** The open document; null on the home page, where every chat is listed. */
  documentId: string | null;
  currentChatId: string | null;
  onOpenChat: (chatId: string) => void;
  onOpenElsewhere: (documentId: string, chatId: string) => void;
  onDeleted: (chatId: string) => void;
}) {
  const phone = useIsPhone();
  const [scope, setScope] = useState<"document" | "all">(documentId ? "document" : "all");
  const [query, setQuery] = useState("");
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setChats(null);
    void Promise.all([
      chatApi.list(scope === "document" && documentId ? documentId : undefined).catch(() => [] as ChatSummary[]),
      api<{ documents: DocumentMeta[] }>("/api/documents").catch(() => ({ documents: [] as DocumentMeta[] })),
    ]).then(([list, docs]) => {
      if (cancelled) return;
      setChats(list);
      setTitles(new Map(docs.documents.map((doc) => [doc.id, doc.title])));
    });
    return () => {
      cancelled = true;
    };
  }, [open, scope, documentId]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    // Phones don't focus the field, so the keyboard doesn't cover the list.
    if (!phone) requestAnimationFrame(() => input.current?.focus());
  }, [open, phone]);

  useEffect(() => {
    if (!open || !phone) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, phone, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!chats) return null;
    if (!q) return chats;
    return chats.filter((chat) => [chat.title, chat.preview, chat.documentId ? titles.get(chat.documentId) : ""].some((text) => text?.toLowerCase().includes(q)));
  }, [chats, query, titles]);

  if (!open) return null;

  const body = (
    <div className="chat-history">
      <div className="chat-history-head">
        <div className="chat-history-search">
          <Search size={14} />
          <input ref={input} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search chats" aria-label="Search chats" />
        </div>
        {documentId && <div className="segmented" role="tablist">
          <button type="button" role="tab" aria-selected={scope === "document"} className={scope === "document" ? "is-active" : ""} onClick={() => setScope("document")}>
            This document
          </button>
          <button type="button" role="tab" aria-selected={scope === "all"} className={scope === "all" ? "is-active" : ""} onClick={() => setScope("all")}>
            All
          </button>
        </div>}
      </div>
      <div className="chat-history-list" role="listbox" aria-label="Chats">
        {filtered === null ? (
          <div className="chat-history-empty">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="chat-history-empty">{query ? `No chats match "${query}".` : scope === "document" ? "No earlier chats for this document." : "No chats yet."}</div>
        ) : (
          filtered.slice(0, 100).map((chat) => {
            const elsewhere = chat.documentId && chat.documentId !== documentId ? chat.documentId : null;
            const docTitle = chat.documentId ? (titles.get(chat.documentId) ?? "Deleted document") : "No document";
            return (
              <div key={chat.id} className={`chat-row${chat.id === currentChatId ? " is-current" : ""}`} role="option" aria-selected={chat.id === currentChatId}>
                <button
                  type="button"
                  className="chat-row-main"
                  onClick={() => {
                    onClose();
                    if (elsewhere) onOpenElsewhere(elsewhere, chat.id);
                    else onOpenChat(chat.id);
                  }}
                >
                  <span className="chat-row-title">{chat.title || "Untitled chat"}</span>
                  {chat.preview && <span className="chat-row-preview">{chat.preview}</span>}
                  <span className="chat-row-meta">
                    {scope === "all" && (
                      <span className={`chat-row-doc${elsewhere || !chat.documentId ? "" : " is-here"}`}>
                        {chat.documentId ? <FileText size={11} /> : <House size={11} />}
                        {!chat.documentId ? "Home" : elsewhere ? docTitle : "This document"}
                      </span>
                    )}
                    <span>{relativeTime(chat.updatedAt)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn-sm chat-row-delete"
                  aria-label={`Delete chat ${chat.title}`}
                  onClick={() => {
                    void chatApi.remove(chat.id).then(() => {
                      setChats((list) => list?.filter((item) => item.id !== chat.id) ?? null);
                      onDeleted(chat.id);
                    });
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );

  if (phone) {
    return createPortal(
      <div className="sheet-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
        <div className="menu menu-sheet chat-history-sheet" role="dialog" aria-label="Chat history">
          <div className="sheet-grabber" aria-hidden />
          {body}
        </div>
      </div>,
      document.body,
    );
  }
  return (
    <Popover open onClose={onClose} anchor={anchor} placement="bottom-end" className="chat-history-popover">
      {body}
    </Popover>
  );
}

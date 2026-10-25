"use client";

import type { Attachment, ChatSettings, DocumentMention, LinkedDocument, SelectionContext } from "@/lib/agent/types";

/**
 * The message being written to Claude, kept per document so closing the panel
 * (or reloading the page) doesn't lose it. Text, attachments, mentions and
 * linked documents are remembered in localStorage; the quoted selection only
 * for this tab, since its positions go stale once the page is gone.
 */
export type Draft = { text: string; attachments: Attachment[]; mentions: DocumentMention[]; links: LinkedDocument[] };

const EMPTY: Draft = { text: "", attachments: [], mentions: [], links: [] };
const selections = new Map<string, SelectionContext>();
const draftSettings = new Map<string, ChatSettings>();

function key(documentId: string) {
  return `inline-draft:${documentId}`;
}

function isLink(value: unknown): value is LinkedDocument {
  if (!value || typeof value !== "object") return false;
  const link = value as LinkedDocument;
  return typeof link.id === "string" && typeof link.title === "string" && (link.purpose === "voice" || link.purpose === "context");
}

export function loadDraft(documentId: string): Draft {
  try {
    const raw = JSON.parse(window.localStorage.getItem(key(documentId)) ?? "null") as Partial<Draft> | null;
    if (!raw || typeof raw !== "object") return EMPTY;
    return {
      text: typeof raw.text === "string" ? raw.text : "",
      attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
      mentions: Array.isArray(raw.mentions) ? raw.mentions : [],
      links: Array.isArray(raw.links) ? raw.links.filter(isLink) : [],
    };
  } catch {
    return EMPTY;
  }
}

export function saveDraft(documentId: string, draft: Draft) {
  try {
    if (!draft.text && !draft.attachments.length && !draft.links.length) window.localStorage.removeItem(key(documentId));
    else window.localStorage.setItem(key(documentId), JSON.stringify(draft));
  } catch {
    // Private browsing or storage full: the draft lasts while the panel is open.
  }
}

export function loadDraftSelection(documentId: string) {
  return selections.get(documentId) ?? null;
}

export function saveDraftSelection(documentId: string, selection: SelectionContext | null) {
  if (selection) selections.set(documentId, selection);
  else selections.delete(documentId);
}

/** The provider, model and options chosen before a chat exists, kept for this tab so closing the panel keeps them. */
export function loadDraftSettings(documentId: string) {
  return draftSettings.get(documentId) ?? null;
}

export function saveDraftSettings(documentId: string, settings: ChatSettings) {
  draftSettings.set(documentId, settings);
}

"use client";

import type { Attachment, DocumentMention, SelectionContext } from "@/lib/agent/types";

/**
 * The message being written to Claude, kept per document so closing the panel
 * (or reloading the page) doesn't lose it. Text, attachments and mentions are
 * remembered in localStorage; the quoted selection only for this tab, since
 * its positions go stale once the page is gone.
 */
export type Draft = { text: string; attachments: Attachment[]; mentions: DocumentMention[] };

const EMPTY: Draft = { text: "", attachments: [], mentions: [] };
const selections = new Map<string, SelectionContext>();

function key(documentId: string) {
  return `inline-draft:${documentId}`;
}

export function loadDraft(documentId: string): Draft {
  try {
    const raw = JSON.parse(window.localStorage.getItem(key(documentId)) ?? "null") as Partial<Draft> | null;
    if (!raw || typeof raw !== "object") return EMPTY;
    return {
      text: typeof raw.text === "string" ? raw.text : "",
      attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
      mentions: Array.isArray(raw.mentions) ? raw.mentions : [],
    };
  } catch {
    return EMPTY;
  }
}

export function saveDraft(documentId: string, draft: Draft) {
  try {
    if (!draft.text && !draft.attachments.length) window.localStorage.removeItem(key(documentId));
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

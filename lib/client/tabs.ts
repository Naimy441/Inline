"use client";

import { useEffect, useSyncExternalStore } from "react";
import { api, del, patch, post, Store } from "@/lib/client/api";
import type { DocumentTab } from "@/lib/doc/settings";

/**
 * Document tabs, cached by the id of every tab in the document, so switching
 * tabs shows the list at once. Live "tabs" events keep it current.
 */
const lists = new Store<Record<string, DocumentTab[]>>({});
const inflight = new Map<string, Promise<void>>();
const ROOT_KEY = "inline-tab-root:";

export function setTabs(tabs: DocumentTab[]) {
  lists.set((current) => {
    const next = { ...current };
    for (const tab of tabs) next[tab.id] = tabs;
    return next;
  });
  // Remember each tab's first tab, which keys the document's Claude chat, for the next visit.
  try {
    for (const tab of tabs.slice(1)) localStorage.setItem(`${ROOT_KEY}${tab.id}`, tabs[0]!.id);
  } catch {
    // ignore
  }
}

export function refreshTabs(documentId: string) {
  let pending = inflight.get(documentId);
  if (!pending) {
    pending = api<{ tabs: DocumentTab[] }>(`/api/documents/${documentId}/tabs`)
      .then((result) => setTabs(result.tabs))
      .catch(() => undefined)
      .finally(() => inflight.delete(documentId));
    inflight.set(documentId, pending);
  }
  return pending;
}

/** The document's tabs (null until first loaded). */
export function useTabs(documentId: string) {
  const all = useSyncExternalStore(lists.subscribe, lists.get, lists.get);
  useEffect(() => {
    void refreshTabs(documentId);
  }, [documentId]);
  return all[documentId] ?? null;
}

/** The id of the document's first tab, as far as this browser knows it. */
export function rememberedRoot(documentId: string) {
  try {
    return localStorage.getItem(`${ROOT_KEY}${documentId}`) ?? documentId;
  } catch {
    return documentId;
  }
}

export async function addTab(documentId: string, title?: string) {
  const result = await post<{ id: string; tabs: DocumentTab[] }>(`/api/documents/${documentId}/tabs`, title ? { title } : {});
  setTabs(result.tabs);
  return result.id;
}

export async function renameTab(tabId: string, title: string) {
  const previous = lists.get()[tabId];
  if (previous) setTabs(previous.map((tab) => (tab.id === tabId ? { ...tab, title } : tab)));
  try {
    const result = await patch<{ tabs: DocumentTab[] }>(`/api/documents/${tabId}/tabs`, { title });
    setTabs(result.tabs);
  } catch (error) {
    if (previous) setTabs(previous);
    throw error;
  }
}

export async function deleteTab(tabId: string) {
  const previous = lists.get()[tabId];
  const result = await del<{ tabs: DocumentTab[] }>(`/api/documents/${tabId}/tabs`);
  if (result.tabs.length) setTabs(result.tabs);
  lists.set((current) => {
    const next = { ...current };
    delete next[tabId];
    return next;
  });
  return previous ?? null;
}

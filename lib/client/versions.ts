"use client";

import { useEffect, useSyncExternalStore } from "react";
import { api, Store } from "@/lib/client/api";

export type VersionSummary = { id: string; documentId: string; label: string; author: "user" | "claude" | "auto"; createdAt: number; wordCount?: number; pendingChanges?: number };

/**
 * Version lists and version contents, cached per document so the history
 * panel and previews open instantly; lists refresh in the background.
 */
const lists = new Store<Record<string, VersionSummary[]>>({});
const docs = new Map<string, Promise<unknown>>();
const inflight = new Map<string, Promise<void>>();

export function refreshVersions(documentId: string) {
  let pending = inflight.get(documentId);
  if (!pending) {
    pending = api<{ versions: VersionSummary[] }>(`/api/documents/${documentId}/versions`)
      .then((result) => lists.set((current) => ({ ...current, [documentId]: result.versions })))
      .catch(() => undefined)
      .finally(() => inflight.delete(documentId));
    inflight.set(documentId, pending);
  }
  return pending;
}

/** The document's versions (null until first loaded), refreshed when shown. */
export function useVersions(documentId: string) {
  const all = useSyncExternalStore(lists.subscribe, lists.get, lists.get);
  useEffect(() => {
    void refreshVersions(documentId);
  }, [documentId]);
  return all[documentId] ?? null;
}

/** A version's saved content; fetched once, then served from memory. */
export function versionDoc(documentId: string, versionId: string) {
  const key = `${documentId}/${versionId}`;
  let doc = docs.get(key);
  if (!doc) {
    doc = api<{ version: { doc: unknown } }>(`/api/documents/${documentId}/versions/${versionId}`).then((result) => result.version.doc);
    doc.catch(() => docs.delete(key));
    docs.set(key, doc);
  }
  return doc;
}

/** Warm the list and the newest few versions, so opening history doesn't wait on the network. */
export function prefetchVersions(documentId: string) {
  void refreshVersions(documentId).then(() => {
    for (const version of (lists.get()[documentId] ?? []).slice(0, 4)) void versionDoc(documentId, version.id).catch(() => undefined);
  });
}

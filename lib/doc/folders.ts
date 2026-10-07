import type { DocumentMeta } from "@/lib/doc/settings";

/** Folders for organizing documents on the home page. They nest; documents point at theirs with `folderId`. */

export const FOLDER_COLORS = ["gray", "clay", "amber", "green", "teal", "blue", "violet", "rose"] as const;
export type FolderColor = (typeof FOLDER_COLORS)[number];

export type Folder = {
  id: string;
  name: string;
  /** The folder it sits in; null at the top level. */
  parentId: string | null;
  color: FolderColor;
  createdAt: number;
  updatedAt: number;
};

export const MAX_FOLDER_DEPTH = 12;

export function cleanFolderName(value: string | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled folder";
}

export function isFolderColor(value: unknown): value is FolderColor {
  return typeof value === "string" && (FOLDER_COLORS as readonly string[]).includes(value);
}

/** The folder and the folders above it, top level first. Stops at a missing parent or a loop. */
export function folderPath(folders: Map<string, Folder>, id: string | null | undefined): Folder[] {
  const path: Folder[] = [];
  const seen = new Set<string>();
  let current = id ? folders.get(id) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? folders.get(current.parentId) : undefined;
  }
  return path;
}

/** Whether `id` is `ancestor` or sits somewhere inside it. */
export function isWithin(folders: Map<string, Folder>, id: string | null | undefined, ancestor: string) {
  return folderPath(folders, id).some((folder) => folder.id === ancestor);
}

/** Can `id` move into `target` (null: the top level) without ending up inside itself or too deep? */
export function canMoveFolder(folders: Map<string, Folder>, id: string, target: string | null) {
  if (target === null) return true;
  if (!folders.has(target) || isWithin(folders, target, id)) return false;
  return folderPath(folders, target).length + subtreeDepth(folders, id) <= MAX_FOLDER_DEPTH;
}

function subtreeDepth(folders: Map<string, Folder>, id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  let deepest = 0;
  for (const folder of folders.values()) if (folder.parentId === id) deepest = Math.max(deepest, subtreeDepth(folders, folder.id, seen));
  return deepest + 1;
}

/** The folder a document is shown in: its own if that still exists, otherwise the top level. */
export function documentFolder(folders: Map<string, Folder>, doc: Pick<DocumentMeta, "folderId">) {
  return doc.folderId && folders.has(doc.folderId) ? doc.folderId : null;
}

export type FolderSummary = {
  /** Documents anywhere inside, most recent first. */
  documents: DocumentMeta[];
  folders: number;
  /** The latest change to anything inside, or the folder itself. */
  updatedAt: number;
};

/** What each folder holds, counting everything in the folders inside it too. */
export function summarizeFolders(folders: Map<string, Folder>, documents: DocumentMeta[]): Map<string, FolderSummary> {
  const summaries = new Map<string, FolderSummary>();
  for (const folder of folders.values()) summaries.set(folder.id, { documents: [], folders: 0, updatedAt: folder.updatedAt });
  for (const folder of folders.values()) {
    for (const ancestor of folderPath(folders, folder.parentId)) summaries.get(ancestor.id)!.folders += 1;
  }
  for (const doc of documents) {
    const at = Math.max(doc.updatedAt, doc.lastOpenedAt);
    for (const ancestor of folderPath(folders, documentFolder(folders, doc))) {
      const summary = summaries.get(ancestor.id)!;
      summary.documents.push(doc);
      summary.updatedAt = Math.max(summary.updatedAt, at);
    }
  }
  for (const summary of summaries.values()) summary.documents.sort((a, b) => Math.max(b.lastOpenedAt, b.updatedAt) - Math.max(a.lastOpenedAt, a.updatedAt));
  return summaries;
}

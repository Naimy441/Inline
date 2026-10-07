import { documentFolder, folderPath, summarizeFolders, type Folder } from "@/lib/doc/folders";
import type { DocumentMeta } from "@/lib/doc/settings";
import { ensureFolderPath, FolderError, folderPathName, listFolders } from "@/lib/server/folders";
import { documentHub } from "@/lib/server/hub";

/**
 * The document library as Claude sees it: the folder tree and every
 * document's title with the first few words of its text. Excerpts come from
 * the preview each document already keeps, so listing a large library reads
 * no document bodies, and stays cheap in tokens.
 */

export const MAX_EXCERPT_WORDS = 40;

export async function library() {
  const [folderList, documents] = await Promise.all([listFolders(), documentHub().list()]);
  return { folders: new Map(folderList.map((folder) => [folder.id, folder])), documents };
}

function excerpt(preview: string, words: number) {
  if (words <= 0 || !preview) return "";
  const all = preview.split(/\s+/).filter(Boolean);
  const text = all.slice(0, words).join(" ");
  return all.length > words || preview.length >= 240 ? `${text}…` : text;
}

/** The folder tree as an indented list, with what each folder holds. */
export function formatFolderTree(folders: Map<string, Folder>, documents: DocumentMeta[]) {
  if (!folders.size) return "No folders yet.";
  const summaries = summarizeFolders(folders, documents);
  const direct = new Map<string, number>();
  for (const doc of documents) {
    const id = documentFolder(folders, doc);
    if (id) direct.set(id, (direct.get(id) ?? 0) + 1);
  }
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    const children = [...folders.values()].filter((folder) => folder.parentId === parent).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const folder of children) {
      const all = summaries.get(folder.id)?.documents.length ?? 0;
      const here = direct.get(folder.id) ?? 0;
      const count = all === here ? `${here} doc${here === 1 ? "" : "s"}` : `${here} here, ${all} in all`;
      lines.push(`${"  ".repeat(depth)}- ${folder.name} (id ${folder.id}, ${folder.color}, ${count})`);
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join("\n");
}

export type LibraryQuery = {
  /** Only documents in this folder (and the folders inside it); null for only unfiled documents at the top level. */
  folderId?: string | null;
  excerptWords: number;
  limit: number;
  offset: number;
  /** The document the user has open, marked in the list. */
  openId?: string | null;
};

export function formatLibrary(folders: Map<string, Folder>, documents: DocumentMeta[], query: LibraryQuery) {
  let docs = documents;
  if (query.folderId === null) docs = docs.filter((doc) => documentFolder(folders, doc) === null);
  else if (query.folderId) docs = docs.filter((doc) => folderPath(folders, documentFolder(folders, doc)).some((folder) => folder.id === query.folderId));
  const total = docs.length;
  const page = docs.slice(query.offset, query.offset + query.limit);
  const lines = page.map((doc) => {
    const where = folderPathName(folders, documentFolder(folders, doc));
    const words = excerpt(doc.preview, query.excerptWords);
    return `- ${doc.id}${doc.id === query.openId ? " (open)" : ""} · "${doc.title}" · ${where ? `in ${where}` : "unfiled"} · ${doc.wordCount.toLocaleString()} words${words ? ` · "${words}"` : ""}`;
  });
  const scope = query.folderId === null ? " unfiled" : query.folderId ? ` in "${folderPathName(folders, query.folderId)}"` : "";
  if (!total) return `No${scope} documents.`;
  const shown = page.length ? `${query.offset + 1}–${query.offset + page.length}` : "none";
  const more = query.offset + page.length < total ? ` Call again with offset ${query.offset + page.length} for the rest.` : "";
  return `${total}${scope} document${total === 1 ? "" : "s"} (showing ${shown}, most recently edited first).${more}\n${lines.join("\n")}`;
}

/**
 * A folder named by id, by path of names ("Work/Q3", matched without regard
 * to case), or "" / "/" for the top level. With `create`, missing folders on
 * the path are made.
 */
export async function resolveFolder(ref: string | null | undefined, options: { create: boolean }) {
  const value = (ref ?? "").trim();
  if (!value || value === "/") return { id: null, created: [] as Folder[] };
  const folders = new Map((await listFolders()).map((folder) => [folder.id, folder]));
  if (folders.has(value)) return { id: value, created: [] as Folder[] };
  const names = value.split("/").map((name) => name.trim()).filter(Boolean);
  if (!options.create) {
    let parent: string | null = null;
    for (const name of names) {
      const match = [...folders.values()].find((folder) => folder.parentId === parent && folder.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0);
      if (!match) throw new FolderError(`There is no folder "${value}". Use list_folders to see the folders.`);
      parent = match.id;
    }
    return { id: parent, created: [] as Folder[] };
  }
  const { folder, created } = await ensureFolderPath(names);
  return { id: folder?.id ?? null, created };
}

export type MoveRequest = { documentId: string; folder: string | null };

/** File documents in folders, making folders named by path as needed. Tabs move with their document. */
export async function moveDocuments(moves: MoveRequest[], options: { create: boolean }) {
  const hub = documentHub();
  const targets = new Map<string, string | null>();
  const created: Folder[] = [];
  for (const ref of new Set(moves.map((move) => (move.folder ?? "").trim()))) {
    const resolved = await resolveFolder(ref, options);
    targets.set(ref, resolved.id);
    created.push(...resolved.created);
  }
  const moved: Array<{ id: string; title: string; to: string | null }> = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  let unchanged = 0;
  for (const move of moves) {
    const live = await hub.get(move.documentId);
    const doc = live?.meta.parentId ? await hub.get(live.meta.parentId) : live;
    if (!doc || doc.meta.trashedAt) {
      problems.push(`${move.documentId}: not found`);
      continue;
    }
    if (seen.has(doc.id)) continue;
    seen.add(doc.id);
    const to = targets.get((move.folder ?? "").trim()) ?? null;
    if ((doc.meta.folderId ?? null) === to) {
      unchanged += 1;
      continue;
    }
    doc.setFolder(to);
    moved.push({ id: doc.id, title: doc.meta.title, to });
  }
  return { moved, created, problems, unchanged };
}

import { canMoveFolder, cleanFolderName, isFolderColor, type Folder, type FolderColor } from "@/lib/doc/folders";
import { newId } from "@/lib/doc/ids";
import { documentHub } from "@/lib/server/hub";
import { readFoldersFile, writeFoldersFile } from "@/lib/server/store";

/**
 * The folder tree, kept in one file (folders.json). Documents name their
 * folder in their own meta, so moving a document only rewrites that document.
 * Changes run one at a time, each reading the file fresh.
 */

export class FolderError extends Error {}

const MAX_FOLDERS = 2000;

let writes: Promise<unknown> = Promise.resolve();

function normalize(raw: unknown): Folder[] {
  const list = Array.isArray((raw as { folders?: unknown } | null)?.folders) ? ((raw as { folders: unknown[] }).folders as Partial<Folder>[]) : [];
  const folders = list
    .filter((item): item is Partial<Folder> & { id: string } => Boolean(item) && typeof item.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(item.id))
    .map((item) => ({
      id: item.id,
      name: cleanFolderName(item.name),
      parentId: typeof item.parentId === "string" ? item.parentId : null,
      color: isFolderColor(item.color) ? item.color : "gray",
      createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
    }));
  // A folder whose parent is gone moves to the top level.
  const ids = new Set(folders.map((folder) => folder.id));
  return folders.map((folder) => (folder.parentId && !ids.has(folder.parentId) ? { ...folder, parentId: null } : folder));
}

export async function listFolders(): Promise<Folder[]> {
  await writes.catch(() => undefined);
  return normalize(await readFoldersFile());
}

async function change<T>(update: (folders: Map<string, Folder>) => Promise<T> | T): Promise<T> {
  const run = writes.catch(() => undefined).then(async () => {
    const folders = new Map(normalize(await readFoldersFile()).map((folder) => [folder.id, folder]));
    const result = await update(folders);
    await writeFoldersFile({ folders: [...folders.values()] });
    return result;
  });
  writes = run.catch(() => undefined);
  return run;
}

function requireFolder(folders: Map<string, Folder>, id: string) {
  const folder = folders.get(id);
  if (!folder) throw new FolderError("That folder was not found.");
  return folder;
}

export async function folderExists(id: string) {
  return (await listFolders()).some((folder) => folder.id === id);
}

export function createFolder(input: { name?: string; parentId?: string | null; color?: FolderColor }) {
  return change((folders) => {
    if (folders.size >= MAX_FOLDERS) throw new FolderError(`You can have up to ${MAX_FOLDERS} folders.`);
    const parentId = input.parentId ?? null;
    if (parentId) requireFolder(folders, parentId);
    const now = Date.now();
    const folder: Folder = { id: newId(10), name: cleanFolderName(input.name), parentId, color: input.color ?? "gray", createdAt: now, updatedAt: now };
    folders.set(folder.id, folder);
    if (!canMoveFolder(folders, folder.id, parentId)) {
      folders.delete(folder.id);
      throw new FolderError("Folders can't be nested that deep.");
    }
    return folder;
  });
}

export function updateFolder(id: string, patch: { name?: string; parentId?: string | null; color?: FolderColor }) {
  return change((folders) => {
    const folder = requireFolder(folders, id);
    const next = { ...folder, updatedAt: Date.now() };
    if (patch.name !== undefined) next.name = cleanFolderName(patch.name);
    if (patch.color !== undefined) next.color = patch.color;
    if (patch.parentId !== undefined && patch.parentId !== folder.parentId) {
      if (patch.parentId && !folders.has(patch.parentId)) throw new FolderError("The folder to move it into was not found.");
      if (!canMoveFolder(folders, id, patch.parentId)) throw new FolderError(patch.parentId === id || (patch.parentId && folders.has(patch.parentId)) ? "A folder can't move into itself or a folder inside it." : "Folders can't be nested that deep.");
      next.parentId = patch.parentId;
    }
    folders.set(id, next);
    return next;
  });
}

/**
 * Delete a folder. Nothing inside is lost: its documents (trashed ones too)
 * and the folders in it move up into its parent.
 */
export function deleteFolder(id: string) {
  return change(async (folders) => {
    const folder = requireFolder(folders, id);
    let moved = 0;
    const hub = documentHub();
    const metas = [...(await hub.list({ purge: false })), ...(await hub.list({ trashed: true, purge: false }))];
    for (const meta of metas) {
      if (meta.folderId !== id) continue;
      const doc = await hub.get(meta.id);
      if (!doc) continue;
      doc.setFolder(folder.parentId);
      moved += 1;
    }
    for (const child of folders.values()) if (child.parentId === id) folders.set(child.id, { ...child, parentId: folder.parentId });
    folders.delete(id);
    return { moved, parentId: folder.parentId };
  });
}

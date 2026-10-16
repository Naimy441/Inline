import { promises as fs } from "node:fs";
import path from "node:path";
import type { HunkJSON } from "@/lib/doc/review";
import type { DocComment, DocumentMeta } from "@/lib/doc/settings";

/**
 * File-backed persistence. Inline runs next to the user's Claude Code, so its
 * data lives on the local disk: one git repository per document, plus chats,
 * written atomically (temp file + rename) through a per-file queue. A version
 * of a document is a commit in that repository, not a separate snapshot.
 *
 * Location: $INLINE_DATA_DIR, or ./.inline in the working directory.
 */

export type StoredDocumentFile = {
  format: 3;
  meta: DocumentMeta;
  /** ProseMirror JSON. */
  doc: unknown;
  comments: DocComment[];
  hunks: HunkJSON[];
};

export function dataDir() {
  return path.resolve(process.env.INLINE_DATA_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), ".inline"));
}

function dir(...parts: string[]) {
  return path.join(dataDir(), ...parts);
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function assertSafeId(id: string) {
  if (!SAFE_ID.test(id)) throw new Error("Invalid id.");
  return id;
}

/**
 * Something derived from a whole JSON file (a document's meta, a chat's
 * summary), kept until the file changes. Lists then read only the files that
 * changed since the last time, instead of parsing every document and chat.
 */
export class FileSummaryCache<T> {
  private entries = new Map<string, { mtimeMs: number; size: number; value: T }>();

  async get(file: string, read: () => Promise<T | null>): Promise<T | null> {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) {
      this.entries.delete(file);
      return null;
    }
    const cached = this.entries.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
    const value = await read();
    if (value !== null) this.entries.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  }
}

export function documentFilePath(id: string) {
  return dir("repos", assertSafeId(id), "document.json");
}

export function chatFilePath(id: string) {
  return dir("chats", `${assertSafeId(id)}.json`);
}

const queues = new Map<string, Promise<void>>();

/** Runs file operations one at a time per path, so a late write can't land after a newer one or a delete. */
async function serialized(file: string, operation: () => Promise<void>) {
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(file, next);
  try {
    await next;
  } finally {
    if (queues.get(file) === next) queues.delete(file);
  }
}

async function writeJsonAtomic(file: string, value: unknown) {
  await serialized(file, async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value), "utf8");
    await fs.rename(tmp, file);
  });
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function removeFile(file: string) {
  await serialized(file, () => fs.rm(file, { force: true }));
}

async function listJson(folder: string): Promise<string[]> {
  try {
    const names = await fs.readdir(folder);
    return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// --- documents --------------------------------------------------------------

export async function readDocumentFile(id: string) {
  assertSafeId(id);
  const primary = await readJson<StoredDocumentFile>(documentFilePath(id));
  if (primary) return primary;
  const legacy = await readJson<StoredDocumentFile>(dir("documents", `${id}.json`));
  if (!legacy) return null;
  const { migrateLegacyDocument } = await import("@/lib/server/repo");
  await migrateLegacyDocument(id);
  return readJson<StoredDocumentFile>(documentFilePath(id));
}

export async function writeDocumentFile(file: StoredDocumentFile) {
  // Enqueue before the first await so parallel writes land in call order.
  const target = documentFilePath(file.meta.id);
  await serialized(target, async () => {
    const { ensureDocumentRepo } = await import("@/lib/server/repo");
    await ensureDocumentRepo(file.meta.id);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(file), "utf8");
    await fs.rename(tmp, target);
  });
}

export async function deleteDocumentFile(id: string) {
  assertSafeId(id);
  await removeFile(dir("documents", `${id}.json`));
  await removeFile(dir("thumbnails", `${id}.img`));
  await removeFile(dir("thumbnails", `${id}.dark.img`));
  await removeFile(dir("pdf-imports", `${id}.json`));
  await fs.rm(dir("repos", id), { recursive: true, force: true });
  await fs.rm(dir("versions", id), { recursive: true, force: true });
  await fs.rm(dir("version-files", id), { recursive: true, force: true });
}

export type ThumbnailTheme = "light" | "dark";

function thumbnailFile(id: string, theme: ThumbnailTheme) {
  return dir("thumbnails", `${assertSafeId(id)}${theme === "dark" ? ".dark" : ""}.img`);
}

/** The small first-page image shown on the home page (WebP or JPEG), drawn for the light or the dark theme. */
export async function writeThumbnail(id: string, data: Uint8Array, theme: ThumbnailTheme = "light") {
  const file = thumbnailFile(id, theme);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, data);
  await fs.rename(temp, file);
}

export async function readThumbnail(id: string, theme: ThumbnailTheme = "light"): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await fs.readFile(thumbnailFile(id, theme)));
  } catch {
    return null;
  }
}

export async function listDocumentIds() {
  const ids = new Set<string>();
  try {
    for (const name of await fs.readdir(dir("repos"))) {
      if (!SAFE_ID.test(name)) continue;
      if (await fs.stat(dir("repos", name, "document.json")).catch(() => null)) ids.add(name);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const id of await listJson(dir("documents"))) ids.add(id);
  return [...ids];
}

// --- chats ------------------------------------------------------------------

export async function readChatFile<T>(id: string) {
  return readJson<T>(dir("chats", `${assertSafeId(id)}.json`));
}

export async function writeChatFile(id: string, value: unknown) {
  await writeJsonAtomic(dir("chats", `${assertSafeId(id)}.json`), value);
}

export async function deleteChatFile(id: string) {
  await removeFile(dir("chats", `${assertSafeId(id)}.json`));
}

export async function listChatIds() {
  return listJson(dir("chats"));
}

// --- PDF imports ------------------------------------------------------------

/** What a PDF import kept for Claude and the annotation overlay (lib/server/pdfImports.ts), one file per document. */
export async function readPdfImportFile<T>(documentId: string) {
  return readJson<T>(dir("pdf-imports", `${assertSafeId(documentId)}.json`));
}

export async function writePdfImportFile(documentId: string, value: unknown) {
  await writeJsonAtomic(dir("pdf-imports", `${assertSafeId(documentId)}.json`), value);
}

// --- settings ---------------------------------------------------------------

export async function readSettingsFile<T>(name: string) {
  return readJson<T>(dir("settings", `${assertSafeId(name)}.json`));
}

export async function writeSettingsFile(name: string, value: unknown) {
  await writeJsonAtomic(dir("settings", `${assertSafeId(name)}.json`), value);
}

// --- uploads ----------------------------------------------------------------

const UPLOAD_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

export function uploadExtension(mime: string) {
  return UPLOAD_TYPES[mime.split(";")[0]!.trim().toLowerCase()] ?? null;
}

export function uploadsDir() {
  return dir("uploads");
}

export async function saveUpload(id: string, extension: string, data: Uint8Array) {
  const file = dir("uploads", `${assertSafeId(id)}.${extension}`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
  return file;
}

export async function findUpload(id: string): Promise<{ file: string; extension: string } | null> {
  assertSafeId(id);
  let names: string[];
  try {
    names = await fs.readdir(dir("uploads"));
  } catch {
    return null;
  }
  const name = names.find((entry) => entry.startsWith(`${id}.`));
  if (!name) return null;
  return { file: dir("uploads", name), extension: name.slice(id.length + 1) };
}

export function mimeForExtension(extension: string) {
  const entry = Object.entries(UPLOAD_TYPES).find(([, ext]) => ext === extension);
  return entry?.[0] ?? "application/octet-stream";
}

export async function workspaceDir() {
  const folder = dir("workspace");
  await fs.mkdir(folder, { recursive: true });
  return folder;
}

// --- dictionary -------------------------------------------------------------
// Words the user (or Claude, for them) added to the spelling dictionary, so
// they aren't underlined. Kept here so Claude's spelling check can skip them.

const MAX_DICTIONARY = 5000;
let dictionaryWrites: Promise<unknown> = Promise.resolve();

export async function readDictionary(): Promise<string[]> {
  const stored = await readJson<{ words?: unknown }>(dir("dictionary.json"));
  return Array.isArray(stored?.words) ? stored.words.filter((word): word is string => typeof word === "string") : [];
}

/** Add and remove words (already normalized) and return the whole dictionary. */
export function updateDictionary(add: readonly string[], remove: readonly string[] = []): Promise<string[]> {
  const run = dictionaryWrites.then(async () => {
    const drop = new Set(remove);
    const words = [...new Set([...(await readDictionary()), ...add])].filter((word) => word && !drop.has(word)).slice(-MAX_DICTIONARY);
    await writeJsonAtomic(dir("dictionary.json"), { words });
    return words;
  });
  dictionaryWrites = run.catch(() => undefined);
  return run;
}

// --- folders ----------------------------------------------------------------

export async function readFoldersFile<T>() {
  return readJson<T>(dir("folders.json"));
}

export async function writeFoldersFile(value: unknown) {
  await writeJsonAtomic(dir("folders.json"), value);
}

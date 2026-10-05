import { promises as fs } from "node:fs";
import path from "node:path";
import type { HunkJSON } from "@/lib/doc/review";
import type { DocComment, DocumentMeta } from "@/lib/doc/settings";

/**
 * File-backed persistence. Inline runs next to the user's Claude Code, so its
 * data lives on the local disk: one JSON file per document, chat and saved
 * version, written atomically (temp file + rename) through a per-file queue.
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

export type StoredVersion = {
  id: string;
  documentId: string;
  label: string;
  createdAt: number;
  author: "user" | "claude" | "auto";
  title: string;
  doc: unknown;
  wordCount: number;
};

export type VersionSummary = Omit<StoredVersion, "doc">;

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

const queues = new Map<string, Promise<void>>();

async function writeJsonAtomic(file: string, value: unknown) {
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(value), "utf8");
      await fs.rename(tmp, file);
    });
  queues.set(file, next);
  try {
    await next;
  } finally {
    if (queues.get(file) === next) queues.delete(file);
  }
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
  await fs.rm(file, { force: true });
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
  return readJson<StoredDocumentFile>(dir("documents", `${assertSafeId(id)}.json`));
}

export async function writeDocumentFile(file: StoredDocumentFile) {
  await writeJsonAtomic(dir("documents", `${assertSafeId(file.meta.id)}.json`), file);
}

export async function deleteDocumentFile(id: string) {
  await removeFile(dir("documents", `${assertSafeId(id)}.json`));
  await fs.rm(dir("versions", assertSafeId(id)), { recursive: true, force: true });
}

export async function listDocumentIds() {
  return listJson(dir("documents"));
}

// --- versions ---------------------------------------------------------------

export async function writeVersion(version: StoredVersion) {
  await writeJsonAtomic(dir("versions", assertSafeId(version.documentId), `${assertSafeId(version.id)}.json`), version);
}

export async function readVersion(documentId: string, id: string) {
  return readJson<StoredVersion>(dir("versions", assertSafeId(documentId), `${assertSafeId(id)}.json`));
}

export async function listVersions(documentId: string): Promise<VersionSummary[]> {
  const ids = await listJson(dir("versions", assertSafeId(documentId)));
  const versions = await Promise.all(ids.map((id) => readVersion(documentId, id)));
  return versions
    .filter((version): version is StoredVersion => Boolean(version))
    .map(({ doc: _doc, ...summary }) => summary)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteVersion(documentId: string, id: string) {
  await removeFile(dir("versions", assertSafeId(documentId), `${assertSafeId(id)}.json`));
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

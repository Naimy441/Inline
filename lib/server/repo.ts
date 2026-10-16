import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { HunkJSON } from "@/lib/doc/review";
import { runInFolder } from "@/lib/server/sandbox";
import {
  assertSafeId,
  dataDir,
  documentFilePath,
  writeDocumentFile,
  type StoredDocumentFile,
} from "@/lib/server/store";

const exec = promisify(execFile);

/**
 * Each document is a git repository: the document file, and any files Claude
 * makes for it, live in one folder. Typing writes the working tree. A version
 * is a commit, and only a commit — nothing is saved automatically.
 *
 * The folder is private. File tools and commands resolve inside it and refuse
 * to leave, and commands run in a sandbox that cannot see other documents.
 */

const SHA = /^[0-9a-f]{40}$/;
const RESERVED = new Set([".git", ".draft", ".tmp", "document.json"]);
const EXCLUDE = `.draft/\n.tmp/\n__pycache__/\n*.pyc\n.DS_Store\n`;

export class UnsavedChangesError extends Error {
  constructor() {
    super("This document has changes that aren't saved as a version. Save a version first, or restore and discard them.");
  }
}

export type VersionAuthor = "user" | "claude";

export type VersionSummary = {
  id: string;
  documentId: string;
  label: string;
  createdAt: number;
  author: VersionAuthor;
  title: string;
  wordCount: number;
  pendingChanges?: number;
  /** Files in the folder at that version, besides the document itself. */
  files: string[];
};

export type SavedVersion = VersionSummary & { doc: unknown; hunks?: HunkJSON[]; canvas?: StoredDocumentFile["canvas"] };

export type WorkspaceFile = { path: string; size: number; kind: "image" | "text" | "other" };

export type DraftFile = { format: 1; updatedAt: number; doc: unknown };

const locks = new Map<string, Promise<unknown>>();

function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  locks.set(id, next);
  return next.finally(() => {
    if (locks.get(id) === next) locks.delete(id);
  });
}

export function documentRepoPath(id: string) {
  return path.join(dataDir(), "repos", assertSafeId(id));
}

function draftPath(id: string) {
  return path.join(documentRepoPath(id), ".draft", "document.json");
}

export async function ensureDocumentRepo(id: string) {
  assertSafeId(id);
  const root = documentRepoPath(id);
  await fs.mkdir(root, { recursive: true });
  if (!(await fs.stat(path.join(root, ".git")).catch(() => null))) {
    await git(id, ["init", "-b", "main"]);
  }
  const info = path.join(root, ".git", "info");
  await fs.mkdir(info, { recursive: true });
  const exclude = path.join(info, "exclude");
  const current = await fs.readFile(exclude, "utf8").catch(() => "");
  if (!current.includes(".draft/")) await fs.writeFile(exclude, `${current.trim()}\n${EXCLUDE}`.trim() + "\n");
  // Once the document itself lives in the repo, the old snapshot folder is not a second history.
  const legacy = path.join(dataDir(), "documents", `${id}.json`);
  if (!(await fs.stat(legacy).catch(() => null))) await fs.rm(path.join(dataDir(), "versions", id), { recursive: true, force: true });
}

type GitResult = { code: number; stdout: string; stderr: string };

async function git(id: string, args: string[], options: { env?: Record<string, string> } = {}): Promise<string> {
  const result = await gitResult(id, args, options);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed.`);
  return result.stdout;
}

async function gitResult(id: string, args: string[], options: { env?: Record<string, string> } = {}): Promise<GitResult> {
  const cwd = documentRepoPath(id);
  try {
    const result = await exec("git", ["-C", cwd, "-c", "user.name=Inline", "-c", "user.email=inline@localhost", "-c", "core.autocrlf=false", ...args], {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        ...options.env,
      },
    });
    return { code: 0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
    if (failed.code === "ENOENT") throw new Error("Git is not installed, so versions can't be saved.");
    return { code: typeof failed.code === "number" ? failed.code : 1, stdout: String(failed.stdout ?? ""), stderr: String(failed.stderr ?? failed.message) };
  }
}

function authorEnv(author: VersionAuthor, date?: Date): Record<string, string> {
  const when = date ? date.toISOString() : undefined;
  return {
    GIT_AUTHOR_NAME: author === "claude" ? "Claude" : "You",
    GIT_AUTHOR_EMAIL: author === "claude" ? "claude@inline.local" : "you@inline.local",
    GIT_COMMITTER_NAME: "Inline",
    GIT_COMMITTER_EMAIL: "inline@localhost",
    ...(when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {}),
  };
}

function commitMessage(input: { label: string; author: VersionAuthor; title: string; wordCount: number; pending: number }) {
  const label = input.label.replace(/[\r\n\u001e\u001f]/g, " ").trim().slice(0, 120) || "Saved version";
  const title = input.title.replace(/[\r\n]/g, " ").trim().slice(0, 200);
  return { label, message: `${label}\n\nInline-Author: ${input.author}\nInline-Words: ${input.wordCount}\nInline-Pending: ${input.pending}\nInline-Title: ${title}\n` };
}

function parseMessage(body: string) {
  const label = body.split("\n")[0]?.trim() || "Saved version";
  const author = (/Inline-Author: (user|claude)/.exec(body)?.[1] ?? "user") as VersionAuthor;
  const wordCount = Number(/Inline-Words: (\d+)/.exec(body)?.[1] ?? 0);
  const pending = Number(/Inline-Pending: (\d+)/.exec(body)?.[1] ?? 0);
  const title = /Inline-Title: (.*)/.exec(body)?.[1]?.trim() ?? "";
  return { label, author, wordCount, pending, title };
}

async function head(id: string) {
  const result = await gitResult(id, ["rev-parse", "--verify", "HEAD"]);
  return result.code === 0 ? result.stdout.trim() : null;
}

async function dirty(id: string) {
  const status = await git(id, ["status", "--porcelain"]);
  return status.trim().length > 0;
}

async function filesAt(id: string, sha: string) {
  const listed = await git(id, ["ls-tree", "-r", "--name-only", sha]);
  return listed
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name && name !== "document.json");
}

async function readTreeFile(id: string, sha: string): Promise<StoredDocumentFile | null> {
  const result = await gitResult(id, ["cat-file", "-p", `${sha}:document.json`]);
  if (result.code !== 0) return null;
  return JSON.parse(result.stdout) as StoredDocumentFile;
}

function assertSha(id: string) {
  if (!SHA.test(id)) throw new Error("Version not found.");
  return id;
}

export async function hasUnsavedChanges(documentId: string) {
  return withLock(documentId, async () => {
    await ensureDocumentRepo(documentId);
    return dirty(documentId);
  });
}

export async function saveDocumentVersion(
  documentId: string,
  input: { label: string; author: VersionAuthor; title: string; wordCount: number; pending: number; date?: Date },
): Promise<VersionSummary> {
  return withLock(documentId, () => saveUnlocked(documentId, input));
}

async function saveUnlocked(
  documentId: string,
  input: { label: string; author: VersionAuthor; title: string; wordCount: number; pending: number; date?: Date },
): Promise<VersionSummary> {
  await ensureDocumentRepo(documentId);
  await git(documentId, ["add", "-A"]);
  if ((await gitResult(documentId, ["diff", "--cached", "--quiet"])).code === 0) {
    throw new Error("Nothing has changed since the last saved version.");
  }
  const { label, message } = commitMessage(input);
  await git(documentId, ["commit", "-m", message], { env: authorEnv(input.author, input.date) });
  const sha = (await git(documentId, ["rev-parse", "HEAD"])).trim();
  const files = await filesAt(documentId, sha);
  return summaryOf(documentId, sha, label, input.author, input.title, input.wordCount, input.pending, input.date?.getTime() ?? Date.now(), files);
}

function summaryOf(
  documentId: string,
  sha: string,
  label: string,
  author: VersionAuthor,
  title: string,
  wordCount: number,
  pending: number,
  createdAt: number,
  files: string[],
): VersionSummary {
  return {
    id: sha,
    documentId,
    label,
    createdAt,
    author,
    title,
    wordCount,
    ...(pending ? { pendingChanges: pending } : {}),
    files,
  };
}

export async function listDocumentVersions(documentId: string): Promise<VersionSummary[]> {
  return withLock(documentId, async () => {
    await ensureDocumentRepo(documentId);
    if (!(await head(documentId))) return [];
    const log = await git(documentId, ["log", "main", "--format=%H%x1f%ct%x1f%B%x1e"]);
    const versions: VersionSummary[] = [];
    for (const record of log.split("\u001e")) {
      const trimmed = record.trim();
      if (!trimmed) continue;
      const [sha, seconds, body = ""] = trimmed.split("\u001f");
      if (!sha || !SHA.test(sha)) continue;
      const parsed = parseMessage(body);
      versions.push(summaryOf(documentId, sha, parsed.label, parsed.author, parsed.title, parsed.wordCount, parsed.pending, Number(seconds) * 1000, await filesAt(documentId, sha)));
    }
    return versions;
  });
}

export async function readDocumentVersion(documentId: string, versionId: string): Promise<SavedVersion | null> {
  return withLock(documentId, async () => {
    if (!SHA.test(versionId)) return null;
    await ensureDocumentRepo(documentId);
    const result = await gitResult(documentId, ["cat-file", "-t", versionId]);
    if (result.code !== 0 || result.stdout.trim() !== "commit") return null;
    const file = await readTreeFile(documentId, versionId);
    if (!file) return null;
    const meta = await git(documentId, ["log", "-1", "--format=%ct%x1f%B", versionId]);
    const [seconds, body = ""] = meta.split("\u001f");
    const parsed = parseMessage(body);
    const pending = file.hunks?.length ?? parsed.pending;
    return {
      ...summaryOf(documentId, versionId, parsed.label, parsed.author, parsed.title || file.meta?.title || "", parsed.wordCount || file.meta?.wordCount || 0, pending, Number(seconds) * 1000, await filesAt(documentId, versionId)),
      doc: file.doc,
      ...(file.hunks?.length ? { hunks: file.hunks } : {}),
      ...(file.canvas ? { canvas: file.canvas } : {}),
    };
  });
}

/**
 * A snapshot taken before an edit, kept as a git object that is not on the
 * version history. The user didn't save it; it only exists so a reply can be undone.
 */
export async function snapshotRewind(documentId: string, label: string): Promise<string> {
  return withLock(documentId, async () => {
    await ensureDocumentRepo(documentId);
    await git(documentId, ["add", "-A"]);
    const tree = (await git(documentId, ["write-tree"])).trim();
    const parent = await head(documentId);
    const message = `${label.replace(/[\r\n]/g, " ").slice(0, 120) || "Before edits"}\n\nInline-Author: user\nInline-Rewind: 1\n`;
    const messageFile = path.join(documentRepoPath(documentId), ".tmp", "commit-msg");
    await fs.mkdir(path.dirname(messageFile), { recursive: true });
    await fs.writeFile(messageFile, message);
    const sha = (await git(documentId, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", messageFile])).trim();
    await fs.rm(messageFile, { force: true });
    await git(documentId, ["update-ref", `refs/inline/rewind/${sha}`, sha]);
    const reset = await gitResult(documentId, ["reset", "-q"]);
    if (reset.code !== 0) await gitResult(documentId, ["rm", "-r", "--cached", "--quiet", "."]);
    return sha;
  });
}

export async function restoreDocumentVersion(documentId: string, versionId: string, options: { discard?: boolean } = {}): Promise<SavedVersion> {
  return withLock(documentId, async () => {
    const sha = assertSha(versionId);
    await ensureDocumentRepo(documentId);
    const kind = await gitResult(documentId, ["cat-file", "-t", sha]);
    if (kind.code !== 0 || kind.stdout.trim() !== "commit") throw new Error("Version not found.");
    if (!(await readTreeFile(documentId, sha))) throw new Error("Version not found.");
    if (!options.discard && (await dirty(documentId))) throw new UnsavedChangesError();
    await git(documentId, ["read-tree", "-u", "--reset", sha]);
    await gitResult(documentId, ["clean", "-fd"]);
    const file = JSON.parse(await fs.readFile(documentFilePath(documentId), "utf8")) as StoredDocumentFile;
    const meta = await git(documentId, ["log", "-1", "--format=%ct%x1f%B", sha]);
    const [seconds, body = ""] = meta.split("\u001f");
    const parsed = parseMessage(body);
    const pending = file.hunks?.length ?? parsed.pending;
    return {
      ...summaryOf(documentId, sha, parsed.label, parsed.author, parsed.title || file.meta.title, file.meta.wordCount ?? parsed.wordCount, pending, Number(seconds) * 1000, await filesAt(documentId, sha)),
      doc: file.doc,
      ...(file.hunks?.length ? { hunks: file.hunks } : {}),
      ...(file.canvas ? { canvas: file.canvas } : {}),
    };
  });
}

/**
 * Move a document from the old flat file (and any named snapshots) into its
 * repository. Automatic snapshots are dropped. Named ones become commits.
 */
export async function migrateLegacyDocument(id: string) {
  return withLock(id, async () => {
    assertSafeId(id);
    const legacyPath = path.join(dataDir(), "documents", `${id}.json`);
    const current = JSON.parse(await fs.readFile(legacyPath, "utf8")) as StoredDocumentFile;
    const named = (await readLegacyVersions(id)).filter((version) => version.author === "user" || version.author === "claude").sort((a, b) => a.createdAt - b.createdAt);
    await ensureDocumentRepo(id);
    for (const version of named) {
      const file: StoredDocumentFile = {
        format: 3,
        meta: { ...current.meta, title: version.title || current.meta.title, wordCount: version.wordCount ?? current.meta.wordCount },
        doc: version.doc,
        comments: [],
        hunks: version.hunks ?? [],
      };
      await writeDocumentFile(file);
      try {
        await saveUnlocked(id, {
          label: version.label,
          author: version.author === "claude" ? "claude" : "user",
          title: file.meta.title,
          wordCount: version.wordCount ?? 0,
          pending: version.hunks?.length ?? 0,
          date: new Date(version.createdAt),
        });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("Nothing has changed")) throw error;
      }
    }
    await writeDocumentFile(current);
    await fs.rm(legacyPath, { force: true });
    await fs.rm(path.join(dataDir(), "versions", id), { recursive: true, force: true });
  });
}

type LegacyVersion = {
  label: string;
  createdAt: number;
  author: string;
  title?: string;
  doc: unknown;
  wordCount?: number;
  hunks?: HunkJSON[];
};

async function readLegacyVersions(id: string): Promise<LegacyVersion[]> {
  const folder = path.join(dataDir(), "versions", id);
  let names: string[] = [];
  try {
    names = await fs.readdir(folder);
  } catch {
    return [];
  }
  const versions: LegacyVersion[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name === "index.json") continue;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(folder, name), "utf8")) as LegacyVersion;
      if (parsed && parsed.doc != null && typeof parsed.createdAt === "number") versions.push(parsed);
    } catch {
      // A damaged snapshot is skipped; it is deleted with the folder.
    }
  }
  return versions;
}

// --- files ------------------------------------------------------------------

function rootReal(id: string) {
  return fs.realpath(documentRepoPath(id));
}

/**
 * Resolve a user-supplied path and prove it stays inside the document folder.
 * Symlinks that point outside are refused, including ones created to escape.
 */
export async function resolveInside(documentId: string, userPath: string, options: { allowMissing?: boolean } = {}) {
  await ensureDocumentRepo(documentId);
  const root = await rootReal(documentId);
  if (userPath.includes("\0")) throw new Error("Invalid path.");
  if (path.isAbsolute(userPath) || /^[A-Za-z]:[\\/]/.test(userPath)) throw new Error("Use a path inside this document's folder.");
  const parts = userPath.split(/[\\/]+/).filter((part) => part && part !== ".");
  if (!parts.length) throw new Error("Name a file inside this document's folder.");
  if (parts.some((part) => part === "..")) throw new Error("That path leaves this document's folder.");
  if (RESERVED.has(parts[0]!)) throw new Error("That path is reserved for the document itself.");
  let current = root;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    const next = path.join(current, part);
    const stat = await fs.lstat(next).catch(() => null);
    const last = i === parts.length - 1;
    if (!stat) {
      if (!options.allowMissing) throw new Error(`No file at ${userPath}.`);
      const parent = await fs.realpath(current).catch(() => null);
      if (!parent || !inside(root, parent)) throw new Error("That path leaves this document's folder.");
      return path.join(parent, ...parts.slice(i));
    }
    if (stat.isSymbolicLink()) {
      const real = await fs.realpath(next).catch(() => null);
      if (!real || !inside(root, real)) throw new Error("That path leaves this document's folder.");
      current = real;
    } else if (stat.isDirectory() && !last) {
      current = next;
    } else if (last) {
      const real = await fs.realpath(next);
      if (!inside(root, real)) throw new Error("That path leaves this document's folder.");
      return real;
    } else {
      throw new Error(`${userPath} is not a file.`);
    }
  }
  if (!inside(root, current) || current === root) throw new Error("That path leaves this document's folder.");
  return current;
}

function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

const TEXT_LIMIT = 1_000_000;
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

export function fileKind(filePath: string): WorkspaceFile["kind"] {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (["md", "txt", "py", "js", "ts", "json", "csv", "html", "css", "svg"].includes(ext) || !ext) return "text";
  return "other";
}

export function mimeForFile(filePath: string) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mimes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    json: "application/json",
    txt: "text/plain",
    md: "text/plain",
    py: "text/plain",
    csv: "text/plain",
    html: "text/html",
  };
  return mimes[ext] ?? "application/octet-stream";
}

async function walk(root: string, dir: string, into: WorkspaceFile[]) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".draft" || entry.name === ".tmp" || entry.name === "document.json") continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const real = await fs.realpath(full).catch(() => null);
      if (!real || !inside(root, real)) continue;
      const stat = await fs.stat(real).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) await walk(root, real, into);
      else into.push({ path: path.relative(root, full).split(path.sep).join("/"), size: stat.size, kind: fileKind(entry.name) });
      continue;
    }
    if (entry.isDirectory()) {
      await walk(root, full, into);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(full);
    into.push({ path: path.relative(root, full).split(path.sep).join("/"), size: stat.size, kind: fileKind(entry.name) });
  }
}

export async function listWorkspaceFiles(documentId: string): Promise<WorkspaceFile[]> {
  await ensureDocumentRepo(documentId);
  const root = await rootReal(documentId);
  const files: WorkspaceFile[] = [];
  await walk(root, root, files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function readWorkspaceBytes(documentId: string, userPath: string) {
  const file = await resolveInside(documentId, userPath);
  const data = await fs.readFile(file);
  return { data, mime: mimeForFile(file), file };
}

export async function readWorkspaceText(documentId: string, userPath: string) {
  const { data, file } = await readWorkspaceBytes(documentId, userPath);
  if (data.byteLength > TEXT_LIMIT) throw new Error("That file is too large to read here.");
  if (fileKind(file) === "image") return { kind: "image" as const, data, mime: mimeForFile(file) };
  if (data.includes(0)) throw new Error("That file isn't text. Images can be read too; other binary files can't.");
  return { kind: "text" as const, text: data.toString("utf8") };
}

export async function writeWorkspaceFile(documentId: string, userPath: string, text: string) {
  if (text.length > TEXT_LIMIT) throw new Error("That file is too large.");
  if (text.includes("\0")) throw new Error("The folder holds text files. Generate images by running a command.");
  return withLock(documentId, async () => {
    const file = await resolveInside(documentId, userPath, { allowMissing: true });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf8");
    return file;
  });
}

export async function deleteWorkspaceFile(documentId: string, userPath: string) {
  return withLock(documentId, async () => {
    const file = await resolveInside(documentId, userPath);
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) throw new Error("Name a file, not a folder.");
    await fs.rm(file);
  });
}

export async function runWorkspaceCommand(documentId: string, command: string, timeoutMs: number) {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("Give a command to run.");
  if (trimmed.length > 20_000) throw new Error("That command is too long.");
  return withLock(documentId, async () => {
    await ensureDocumentRepo(documentId);
    const root = documentRepoPath(documentId);
    return runInFolder(root, trimmed, timeoutMs);
  });
}

// --- drafts -----------------------------------------------------------------

export async function readDraft(documentId: string): Promise<DraftFile | null> {
  await ensureDocumentRepo(documentId);
  try {
    const parsed = JSON.parse(await fs.readFile(draftPath(documentId), "utf8")) as DraftFile;
    if (parsed?.format !== 1 || parsed.doc == null) return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeDraft(documentId: string, doc: unknown) {
  await ensureDocumentRepo(documentId);
  const file: DraftFile = { format: 1, updatedAt: Date.now(), doc };
  const target = draftPath(documentId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file));
  await fs.rename(tmp, target);
  return file;
}

export async function discardDraft(documentId: string) {
  await fs.rm(path.dirname(draftPath(documentId)), { recursive: true, force: true });
}

export function workspaceFileUrl(documentId: string, userPath: string) {
  const encoded = userPath
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `/api/documents/${documentId}/files/${encoded}`;
}

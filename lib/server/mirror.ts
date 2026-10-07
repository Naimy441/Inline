import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { documentToDocx, type ImageLoader } from "@/lib/doc/docx";
import { folderPath, type Folder } from "@/lib/doc/folders";
import type { DocumentMeta } from "@/lib/doc/settings";
import type { ZipEntry } from "@/lib/doc/zip";
import { listFolders } from "@/lib/server/folders";
import { documentHub, tabTitle } from "@/lib/server/hub";
import { loadImage } from "@/lib/server/images";
import { log } from "@/lib/server/log";
import { readSettingsFile, writeSettingsFile } from "@/lib/server/store";

/**
 * A copy of every document as a Word file in a real folder on disk, laid out
 * in the same folders as on the home page, so the user owns their documents
 * outside Inline. Word keeps everything the page shows: fonts, margins, page
 * size, headers and footers, page numbers, images and tables.
 *
 * It never slows the editor down. Saves only poke it; a background pass runs
 * once things go quiet, works out what changed from document metadata alone
 * (no document is read unless its Word file must be rewritten), then writes
 * one file at a time, yielding between files. The first pass runs when the
 * server is first used (see documentHub()). A manifest in the folder
 * remembers which file belongs to which document, so renames, moves, trashing
 * and deleting move or remove that file rather than leaving copies behind.
 */

export const TRASH_FOLDER = "Inline Trash";
const MANIFEST = ".inline-mirror.json";
/** How long things must stay quiet before a pass, and the longest a change waits while edits keep coming. */
const QUIET_MS = 2000;
const MAX_WAIT_MS = 10_000;

export type MirrorSettings = { enabled: boolean; dir: string };
export type MirrorConfig = MirrorSettings & { source: "env" | "settings" | "default" };
export type MirrorStatus = MirrorConfig & {
  /** The server's operating system, which decides what "show in the file manager" opens. */
  platform: NodeJS.Platform;
  state: "off" | "idle" | "syncing" | "error";
  files: number;
  lastSyncAt: number | null;
  error: string | null;
};

type Entry = { path: string; key: string };
type Manifest = { version: 1; docs: Record<string, Entry>; folders?: Record<string, string> };

export function defaultMirrorDir() {
  return path.join(os.homedir(), "Documents", "Inline");
}

function expandHome(dir: string) {
  return dir === "~" || dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(1)) : dir;
}

/**
 * Where the copies go: INLINE_MIRROR_DIR when set ("off" turns it off), else
 * the folder chosen on the home page, else ~/Documents/Inline. Test runs stay
 * off unless they ask, so they never write into the user's home folder.
 */
export async function mirrorConfig(): Promise<MirrorConfig> {
  const env = process.env.INLINE_MIRROR_DIR;
  if (env !== undefined) {
    const off = !env.trim() || env.trim().toLowerCase() === "off";
    return { enabled: !off, dir: off ? defaultMirrorDir() : path.resolve(expandHome(env.trim())), source: "env" };
  }
  const stored = await readSettingsFile<Partial<MirrorSettings>>("mirror").catch(() => null);
  if (stored && typeof stored.enabled === "boolean") {
    return { enabled: stored.enabled, dir: path.resolve(expandHome(typeof stored.dir === "string" && stored.dir.trim() ? stored.dir.trim() : defaultMirrorDir())), source: "settings" };
  }
  return { enabled: !process.env.NODE_TEST_CONTEXT, dir: defaultMirrorDir(), source: "default" };
}

/** A file or folder name that's safe on every common file system. */
export function safeName(name: string, fallback: string) {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 120);
  // Windows reserves these names whatever the extension.
  return !cleaned || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned) ? fallback : cleaned;
}

/** What a document's Word file reflects; when it changes, the file is rewritten. */
function contentKey(root: DocumentMeta, tabs: DocumentMeta[]) {
  return JSON.stringify([root.title, root.updatedAt, ...tabs.map((tab) => [tab.id, tab.updatedAt, tab.tabTitle ?? ""])]);
}

/**
 * Where each document's file belongs, relative to the mirror folder. Names
 * that clash get " (2)", " (3)"…; a document keeps the name it already has
 * while that's still right, so a newcomer with the same title takes the
 * next number rather than renaming the older file.
 */
export function plannedPaths(metas: DocumentMeta[], folders: Map<string, Folder>, previous: Record<string, Entry> = {}, reserved: ReadonlySet<string> = new Set()) {
  const plan = new Map<string, string>();
  const taken = new Set<string>(reserved);
  const free = (file: string) => !taken.has(file.toLowerCase());
  const roots = metas.filter((meta) => !meta.parentId).sort((a, b) => Number(!previous[a.id]) - Number(!previous[b.id]) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const meta of roots) {
    const steps = folderPath(folders, meta.folderId && folders.has(meta.folderId) ? meta.folderId : null).map((folder) => safeName(folder.name, "Folder"));
    const dir = [...(meta.trashedAt ? [TRASH_FOLDER] : []), ...steps].join("/");
    const stem = `${dir ? `${dir}/` : ""}${safeName(meta.title, "Untitled document")}`;
    const candidate = (n: number) => `${stem}${n > 1 ? ` (${n})` : ""}.docx`;
    const wanted = previous[meta.id]?.path;
    let target: string;
    if (wanted && free(wanted) && (wanted === candidate(1) || new RegExp(`^${escape(stem)} \\(\\d+\\)\\.docx$`).test(wanted))) target = wanted;
    else {
      let n = 1;
      while (!free(candidate(n))) n += 1;
      target = candidate(n);
    }
    plan.set(meta.id, target);
    taken.add(target.toLowerCase());
  }
  return plan;
}

/** Each folder's path relative to the mirror folder, so empty folders exist on disk too. */
export function plannedFolders(folders: Map<string, Folder>) {
  return new Map([...folders.keys()].map((id) => [id, folderPath(folders, id).map((folder) => safeName(folder.name, "Folder")).join("/")]));
}

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writeAtomic(file: string, data: Uint8Array | string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  );

/** Every folder inside `dir`, at any depth. */
async function subfolders(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    found.push(child, ...(await subfolders(child)));
  }
  return found;
}

const yieldToEditor = () => new Promise((resolve) => setImmediate(resolve));

/** Remove folders a move or delete left empty, up to (not including) the mirror folder. */
async function pruneEmpty(root: string, dir: string) {
  let current = dir;
  while (current.startsWith(root + path.sep)) {
    const entries = await fs.readdir(current).catch(() => null);
    if (!entries || entries.some((name) => !name.startsWith(".") || name === MANIFEST)) return;
    // Only dot files (.DS_Store) left: the folder is ours to remove.
    await fs.rm(current, { recursive: true, force: true }).catch(() => undefined);
    current = path.dirname(current);
  }
}

class Mirror {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstPoke = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private manifest: Manifest | null = null;
  private manifestDir: string | null = null;
  private status: Omit<MirrorStatus, keyof MirrorConfig | "platform"> = { state: "idle", files: 0, lastSyncAt: null, error: null };
  /** Web images rarely change; keep them between passes instead of fetching on every save. */
  private webImages = new Map<string, { data: Uint8Array; mime: string } | null>();

  /** Something changed: sync once things go quiet. Cheap enough to call on every save. */
  poke() {
    const now = Date.now();
    if (!this.timer) this.firstPoke = now;
    else clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(QUIET_MS, this.firstPoke + MAX_WAIT_MS - now));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync();
    }, wait);
    this.timer.unref?.();
  }

  /** Run a pass now (and another after it if more changes come in meanwhile). */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async getStatus(): Promise<MirrorStatus> {
    const config = await mirrorConfig();
    return { ...config, ...this.status, platform: process.platform, state: config.enabled ? this.status.state : "off" };
  }

  private loadImage: ImageLoader = async (src) => {
    if (!/^https?:\/\//i.test(src)) return loadImage(src);
    if (this.webImages.has(src)) return this.webImages.get(src)!;
    const image = await loadImage(src);
    if (this.webImages.size > 200) this.webImages.delete(this.webImages.keys().next().value!);
    this.webImages.set(src, image);
    return image;
  };

  private async readManifest(dir: string): Promise<Manifest> {
    if (this.manifest && this.manifestDir === dir) return this.manifest;
    const raw = await fs.readFile(path.join(dir, MANIFEST), "utf8").catch(() => null);
    let manifest: Manifest = { version: 1, docs: {} };
    try {
      const parsed = raw ? (JSON.parse(raw) as Manifest) : null;
      if (parsed && parsed.version === 1 && parsed.docs && typeof parsed.docs === "object") manifest = parsed;
    } catch {
      // A damaged manifest starts over; files are matched up again by path.
    }
    this.manifest = manifest;
    this.manifestDir = dir;
    return manifest;
  }

  private async pass() {
    const config = await mirrorConfig();
    if (!config.enabled) {
      this.status = { ...this.status, state: "idle", error: null };
      return;
    }
    this.status = { ...this.status, state: "syncing" };
    try {
      const root = config.dir;
      await fs.mkdir(root, { recursive: true });
      const manifest = await this.readManifest(root);
      const hub = documentHub();
      const [metas, folderList] = await Promise.all([hub.allMetas(), listFolders()]);
      const folders = new Map(folderList.map((folder) => [folder.id, folder]));
      const byId = new Map(metas.map((meta) => [meta.id, meta]));
      // Never overwrite a file Inline didn't write: a name already used by one of the user's own files gets a number.
      const owned = new Set(Object.values(manifest.docs).map((entry) => entry.path.toLowerCase()));
      const reserved = new Set<string>();
      let plan = plannedPaths(metas, folders, manifest.docs, reserved);
      for (let round = 0; round < 5; round += 1) {
        let clash = false;
        for (const target of plan.values()) {
          if (owned.has(target.toLowerCase()) || reserved.has(target.toLowerCase())) continue;
          if (await exists(path.join(root, target))) {
            reserved.add(target.toLowerCase());
            clash = true;
          }
        }
        if (!clash) break;
        plan = plannedPaths(metas, folders, manifest.docs, reserved);
      }
      let changed = false;

      // Documents that are gone for good: remove their files.
      for (const [id, entry] of Object.entries(manifest.docs)) {
        if (plan.has(id)) continue;
        const file = path.join(root, entry.path);
        await fs.rm(file, { force: true });
        await pruneEmpty(root, path.dirname(file));
        delete manifest.docs[id];
        changed = true;
      }

      // Moves and renames first, so a document taking over a freed-up name finds it free.
      for (const [id, target] of plan) {
        const entry = manifest.docs[id];
        if (!entry || entry.path === target) continue;
        const from = path.join(root, entry.path);
        const to = path.join(root, target);
        await fs.mkdir(path.dirname(to), { recursive: true });
        const moved = await fs.rename(from, to).then(
          () => true,
          () => false,
        );
        await pruneEmpty(root, path.dirname(from));
        manifest.docs[id] = { path: target, key: moved ? entry.key : "" };
        changed = true;
      }

      // Then write what's new or changed, one file at a time.
      for (const [id, target] of plan) {
        const meta = byId.get(id)!;
        const tabs = (meta.tabs?.length ? meta.tabs : [id]).map((tabId) => byId.get(tabId)).filter((tab): tab is DocumentMeta => Boolean(tab && (tab.id === id || (!tab.trashedAt && tab.parentId === id))));
        const key = contentKey(meta, tabs);
        const file = path.join(root, target);
        if (manifest.docs[id]?.key === key && (await exists(file))) continue;
        await yieldToEditor();
        const data = await this.render(id);
        if (!data) continue;
        await writeAtomic(file, data);
        manifest.docs[id] = { path: target, key };
        changed = true;
      }

      // Every folder exists on disk, empty ones included; folders that were renamed, moved or deleted are tidied away once empty.
      const folderPlan = plannedFolders(folders);
      const wanted = new Set([...folderPlan.values()].map((dir) => dir.toLowerCase()));
      for (const old of Object.values(manifest.folders ?? {})) {
        if (!old || wanted.has(old.toLowerCase())) continue;
        const dir = path.join(root, old);
        // Deepest first: a removed folder's own empty subfolders go with it.
        for (const child of (await subfolders(dir)).sort((a, b) => b.length - a.length)) await pruneEmpty(root, child);
        await pruneEmpty(root, dir);
      }
      // Made after tidying, which may have removed an empty parent that's still wanted.
      for (const dir of folderPlan.values()) if (dir) await fs.mkdir(path.join(root, dir), { recursive: true });
      const nextFolders = Object.fromEntries(folderPlan);
      if (JSON.stringify(nextFolders) !== JSON.stringify(manifest.folders ?? {})) {
        manifest.folders = nextFolders;
        changed = true;
      }

      if (changed) await writeAtomic(path.join(root, MANIFEST), JSON.stringify(manifest));
      this.status = { state: "idle", files: plan.size, lastSyncAt: Date.now(), error: null };
    } catch (error) {
      log("error", "copying documents to the folder on disk failed", { error });
      this.status = { ...this.status, state: "error", error: error instanceof Error ? error.message : String(error) };
      // Start fresh next time in case the folder changed under us.
      this.manifest = null;
    }
  }

  /** The document, all its tabs, as a Word file; null if it vanished meanwhile. */
  private async render(id: string) {
    const hub = documentHub();
    const live = await hub.get(id);
    if (!live) return null;
    const tabs = live.meta.trashedAt ? [live] : (await hub.family(id)).tabs;
    // Each tab is a titled section, as Google Docs writes tabs, so the file reads back in with its tabs; comments come along.
    if (tabs.length === 1) return documentToDocx(live.doc, live.meta, this.loadImage, live.snapshot().comments);
    return documentToDocx(tabs.map((tab, index) => ({ title: tabTitle(tab.meta, index), doc: tab.doc, comments: tab.snapshot().comments })), live.meta, this.loadImage);
  }

  /**
   * Every document as a Word file at the same path it has (or would have) in
   * the folder on disk, for Download all. Drawn fresh, so it works with
   * copies turned off too.
   */
  async tree(): Promise<ZipEntry[]> {
    const config = await mirrorConfig();
    const previous = config.enabled ? (await this.readManifest(config.dir)).docs : {};
    const [metas, folderList] = await Promise.all([documentHub().allMetas(), listFolders()]);
    const plan = plannedPaths(metas, new Map(folderList.map((folder) => [folder.id, folder])), previous);
    const entries: ZipEntry[] = [];
    for (const [id, target] of plan) {
      await yieldToEditor();
      const data = await this.render(id);
      if (data) entries.push({ name: target, data });
    }
    return entries;
  }

  /**
   * The file or folder on disk for a document (its tabs count as it), a
   * folder, or the mirror folder itself, once it's up to date. Null when
   * copies are off or the document is gone.
   */
  async locate(target: { documentId?: string; folderId?: string | null }): Promise<{ path: string; isFile: boolean } | null> {
    const config = await mirrorConfig();
    if (!config.enabled) return null;
    await this.sync();
    const manifest = await this.readManifest(config.dir);
    if (target.documentId) {
      const meta = (await documentHub().get(target.documentId))?.meta;
      const id = meta?.parentId ?? target.documentId;
      const entry = manifest.docs[id];
      return entry ? { path: path.join(config.dir, entry.path), isFile: true } : null;
    }
    if (target.folderId) {
      const dir = manifest.folders?.[target.folderId];
      return dir ? { path: path.join(config.dir, dir), isFile: false } : null;
    }
    return { path: config.dir, isFile: false };
  }

  /** Forget the manifest after the folder changes, so the next pass starts from the new one. */
  reset() {
    this.manifest = null;
    this.manifestDir = null;
  }
}

const globalForMirror = globalThis as unknown as { __inlineMirror?: Mirror };

export function mirror(): Mirror {
  globalForMirror.__inlineMirror ??= new Mirror();
  return globalForMirror.__inlineMirror;
}

/** Choose the folder (or turn copying off). Copies start in the new folder at once; the old folder is left as it is. */
export async function setMirrorSettings(settings: Partial<MirrorSettings>) {
  const current = await mirrorConfig();
  const next: MirrorSettings = { enabled: settings.enabled ?? current.enabled, dir: settings.dir?.trim() || current.dir };
  await writeSettingsFile("mirror", next);
  mirror().reset();
  if (next.enabled) void mirror().sync();
  return mirror().getStatus();
}

/**
 * Show a file (selected in its folder) or open a folder in the file manager
 * of the computer Inline runs on: Finder, File Explorer, or the desktop's
 * file manager on Linux (which opens the containing folder).
 */
export function revealInFileManager(target: string, isFile: boolean): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", isFile ? ["-R", target] : [target]]
      : process.platform === "win32"
        ? ["explorer.exe", isFile ? [`/select,${target}`] : [target]]
        : ["xdg-open", [isFile ? path.dirname(target) : target]];
  return new Promise((resolve, reject) => {
    // Not a file the app reads: keep the build from tracing the project for it.
    const child = spawn(/* turbopackIgnore: true */ command, args, { detached: true, stdio: "ignore" });
    child.once("error", (error) => reject(new Error(`Couldn't open the file manager (${command}): ${error.message}`)));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

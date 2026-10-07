import { Node as PMNode } from "prosemirror-model";
import { Step, Transform } from "prosemirror-transform";
import { docPlainText, docWordCount, rangeMarkTexts, wordCount } from "@/lib/doc/editing";
import { blockIdFixes, ensureBlockIds, newId } from "@/lib/doc/ids";
import { markdownToDoc } from "@/lib/doc/markdown";
import { acceptHunks, hunkFromJSON, hunkToJSON, mapHunks, recordAgentChange, rejectHunks, USER_AUTHOR, type Hunk, type HunkJSON } from "@/lib/doc/review";
import { emptyDoc, schema } from "@/lib/doc/schema";
import {
  DEFAULT_SETTINGS,
  cleanTitle,
  layoutKey,
  normalizeSettings,
  titleFromText,
  patchSettings,
  type CommentAuthor,
  type DocComment,
  type DocumentMeta,
  type DocumentTab,
  type TabHeading,
  type DocumentSettings,
} from "@/lib/doc/settings";
import { libraryChanged } from "@/lib/server/changes";
import { log } from "@/lib/server/log";
import {
  deleteDocumentFile,
  listDocumentIds,
  listVersions,
  pruneVersions,
  readDocumentFile,
  readVersion,
  writeDocumentFile,
  writeVersion,
  type StoredDocumentFile,
  type VersionSummary,
  documentFilePath,
  FileSummaryCache,
} from "@/lib/server/store";

/**
 * The document hub is the single authority for every open document. Browser
 * editors sync with it using the prosemirror-collab protocol (versioned
 * steps), and the agent's MCP tools change documents by applying transforms
 * here, so a change from any source reaches every viewer the same way.
 */

export type ChangeOrigin =
  | { kind: "client"; clientID: string }
  | { kind: "agent"; author: string; tool?: string; turn?: string }
  | { kind: "system"; label: string };

export type AgentActivity = {
  chatId: string;
  status: "reading" | "editing" | "thinking" | "idle";
  label: string;
  /** Document range the agent is working on, at `version`. */
  range?: { from: number; to: number };
  version: number;
  at: number;
};

export type ClientCommand =
  | { kind: "print" }
  | { kind: "export_pdf"; tabs?: "all" | "tab" }
  | { kind: "open_document"; documentId: string }
  | { kind: "scroll_to"; from: number; to: number; version: number }
  | { kind: "download"; url: string; filename: string }
  | { kind: "dictionary"; words: string[] };

export type HubEvent =
  | { type: "steps"; version: number; steps: unknown[]; clientIDs: string[]; hunks?: HunkJSON[] }
  | { type: "hunks"; version: number; hunks: HunkJSON[] }
  | { type: "meta"; meta: DocumentMeta }
  | { type: "comments"; comments: DocComment[] }
  | { type: "reset"; epoch: string; version: number; doc: unknown; hunks: HunkJSON[] }
  | { type: "activity"; activity: AgentActivity | null }
  | { type: "command"; command: ClientCommand }
  | { type: "tabs"; tabs: DocumentTab[] }
  | { type: "deleted" };

export type DocumentSnapshot = {
  meta: DocumentMeta;
  /** Identifies this in-memory copy; versions restart at 0 when the server reloads a document. */
  epoch: string;
  doc: unknown;
  version: number;
  comments: DocComment[];
  hunks: HunkJSON[];
  activity: AgentActivity | null;
};

export type ClientSelection = { from: number; to: number; version: number; at: number };

/** Pages as the user's editor laid them out at `version`: where each page after the first starts, and how full the last one is. */
type PageFall = { pages: number; starts: number[]; lastPageFill: number };
/** How the user's editor laid the pages out; `kept` is the layout once pending changes are kept, when deleted text is still showing. */
export type ClientLayout = PageFall & { version: number; words: number; at: number; settings?: string; kept?: PageFall };

const STEP_LOG_LIMIT = 2000;
const PERSIST_DELAY_MS = 400;
const AUTO_VERSION_INTERVAL_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const UNLOAD_AFTER_MS = 15 * 60 * 1000;

export class StepConflictError extends Error {
  constructor(readonly version: number) {
    super("Version mismatch.");
  }
}

/** The client's steps were based on an earlier load of the document (the server restarted); it must reload. */
export class StaleEpochError extends Error {
  constructor(readonly epoch: string) {
    super("The document was reloaded on the server.");
  }
}

export class LiveDocument {
  doc: PMNode;
  version = 0;
  /** Versions are only comparable within one epoch: a server restart starts a new one at version 0. */
  readonly epoch = newId(10);
  hunks: Hunk[];
  comments: DocComment[];
  meta: DocumentMeta;
  activity: AgentActivity | null = null;
  selection: ClientSelection | null = null;
  /** The latest page layout an open editor reported; current only while its version matches. */
  layout: ClientLayout | null = null;
  private layoutWaiters = new Set<() => void>();
  /** The mode the user's editor is in, so Claude knows whether they're suggesting or only viewing. */
  editorMode: "editing" | "suggesting" | "viewing" = "editing";
  /** What the user did outside Claude's replies (restored a version, undid Claude's changes), told to Claude with the next message. */
  userEvents: Array<{ at: number; text: string }> = [];
  private log: Array<{ step: Step; clientID: string }> = [];
  private listeners = new Set<(event: HubEvent) => void>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAutoVersion = 0;
  private lastVersionId: string | null = null;
  private dirtySinceVersion = false;
  private deleted = false;

  constructor(file: StoredDocumentFile) {
    this.meta = file.meta;
    this.doc = loadDoc(file.doc);
    this.comments = Array.isArray(file.comments) ? file.comments : [];
    this.hunks = (file.hunks ?? []).flatMap((json) => {
      try {
        const hunk = hunkFromJSON(json, schema);
        return hunk.to <= this.doc.content.size ? [hunk] : [];
      } catch {
        return [];
      }
    });
  }

  get id() {
    return this.meta.id;
  }

  snapshot(): DocumentSnapshot {
    return {
      meta: this.meta,
      epoch: this.epoch,
      doc: this.doc.toJSON(),
      version: this.version,
      comments: this.comments,
      hunks: this.hunksJSON(),
      activity: this.activity,
    };
  }

  hunksJSON(): HunkJSON[] {
    return this.hunks.map((hunk) => hunkToJSON(hunk, this.doc));
  }

  subscribe(listener: (event: HubEvent) => void) {
    this.listeners.add(listener);
    this.lastUsed = Date.now();
    return () => {
      this.listeners.delete(listener);
      this.lastUsed = Date.now();
    };
  }

  /** When this document was last opened, watched or changed; idle documents are unloaded from memory. */
  lastUsed = Date.now();

  /** Nothing is watching it and nothing is waiting to be saved. */
  get idle() {
    return this.listeners.size === 0 && !this.persistTimer;
  }

  get subscriberCount() {
    return this.listeners.size;
  }

  private emit(event: HubEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken listener must not stop delivery to others.
      }
    }
  }

  /** Steps since `version`, or null when the log no longer reaches back that far. */
  stepsSince(version: number): { steps: unknown[]; clientIDs: string[] } | null {
    const start = this.version - this.log.length;
    if (version < start || version > this.version) return null;
    const slice = this.log.slice(version - start);
    return { steps: slice.map((entry) => entry.step.toJSON()), clientIDs: slice.map((entry) => entry.clientID) };
  }

  /**
   * Apply steps from a browser editor (prosemirror-collab protocol). In
   * suggesting mode the edit is recorded as a pending change for review, the
   * same way Claude's edits are.
   */
  receiveClientSteps(version: number, stepsJSON: unknown[], clientID: string, options: { suggest?: boolean; epoch?: string } = {}) {
    if (this.deleted) throw new Error("Document was deleted.");
    if (options.epoch !== undefined && options.epoch !== this.epoch) throw new StaleEpochError(this.epoch);
    if (version !== this.version) throw new StepConflictError(this.version);
    const tr = new Transform(this.doc);
    for (const json of stepsJSON) {
      const step = Step.fromJSON(schema, json);
      const result = tr.maybeStep(step);
      if (result.failed) throw new Error(`Step rejected: ${result.failed}`);
    }
    const hunks = options.suggest ? recordAgentChange(this.doc, tr, this.hunks, USER_AUTHOR) : mapHunks(this.hunks, tr.mapping);
    this.commit(tr, { kind: "client", clientID }, hunks);
    return this.version;
  }

  /**
   * Apply a server-side transform (agent tool, review action, restore). The
   * transform must be based on the current document.
   */
  applyTransform(tr: Transform, origin: ChangeOrigin, options: { hunks?: Hunk[] } = {}) {
    if (this.deleted) throw new Error("Document was deleted.");
    if (tr.before !== this.doc && !tr.before.eq(this.doc)) throw new Error("Transform is not based on the current document.");
    if (!tr.docChanged) return false;
    const fixes = blockIdFixes(tr.doc);
    if (fixes) for (const step of fixes.steps) tr.step(step);
    const hunks =
      options.hunks ??
      (origin.kind === "agent" ? recordAgentChange(this.doc, tr, this.hunks, origin.author, Date.now(), origin.turn) : mapHunks(this.hunks, tr.mapping));
    this.commit(tr, origin, hunks);
    return true;
  }

  private commit(tr: Transform, origin: ChangeOrigin, hunks: Hunk[]) {
    if (!tr.steps.length) return;
    const clientID = origin.kind === "client" ? origin.clientID : origin.kind === "agent" ? `agent:${origin.author}` : `system:${origin.label}`;
    // Clients map pending changes through the steps themselves, so the list is only sent when that wouldn't give the same result.
    const hunksChanged = !onlyMapped(tr.before, this.hunks, tr, hunks);
    this.doc = tr.doc;
    this.hunks = hunks;
    for (const step of tr.steps) this.log.push({ step, clientID });
    this.version += tr.steps.length;
    if (this.log.length > STEP_LOG_LIMIT) this.log.splice(0, this.log.length - STEP_LOG_LIMIT);
    if (this.selection) {
      const map = tr.mapping;
      this.selection = { ...this.selection, from: map.map(this.selection.from), to: map.map(this.selection.to), version: this.version };
    }
    this.emit({
      type: "steps",
      version: this.version,
      steps: tr.steps.map((step) => step.toJSON()),
      clientIDs: tr.steps.map(() => clientID),
      ...(hunksChanged ? { hunks: this.hunksJSON() } : {}),
    });
    this.meta = { ...this.meta, updatedAt: Date.now() };
    this.dirtySinceVersion = true;
    this.lastUsed = Date.now();
    this.schedulePersist();
  }

  // --- review ---------------------------------------------------------------

  review(action: "accept" | "reject", ids: string[] | "all") {
    const set = ids === "all" ? "all" : new Set(ids);
    if (action === "accept") {
      this.hunks = acceptHunks(this.hunks, set);
      this.emit({ type: "hunks", version: this.version, hunks: this.hunksJSON() });
      this.schedulePersist();
      return { changed: false };
    }
    const { tr, remaining } = rejectHunks(this.doc, this.hunks, set);
    if (!tr.docChanged) {
      this.hunks = remaining;
      this.emit({ type: "hunks", version: this.version, hunks: this.hunksJSON() });
      this.schedulePersist();
      return { changed: false };
    }
    this.applyTransform(tr, { kind: "system", label: "review" }, { hunks: remaining });
    return { changed: true };
  }

  noteUserEvent(text: string) {
    this.userEvents.push({ at: Date.now(), text });
    if (this.userEvents.length > 20) this.userEvents.splice(0, this.userEvents.length - 20);
  }

  // --- meta -----------------------------------------------------------------

  /** Called when the title changes, so the document's other tabs can follow. Set by the hub. */
  onRetitle: ((title: string) => void) | null = null;

  updateMeta(patch: { title?: string; settings?: unknown }) {
    const next = { ...this.meta };
    if (patch.title !== undefined) {
      next.title = cleanTitle(patch.title);
      next.autoTitle = false;
    }
    if (patch.settings !== undefined) next.settings = patchSettings(this.meta.settings, patch.settings);
    next.updatedAt = Date.now();
    const retitled = next.title !== this.meta.title;
    this.meta = next;
    this.emit({ type: "meta", meta: this.meta });
    this.schedulePersist();
    if (retitled) this.onRetitle?.(next.title);
    return this.meta;
  }

  /** Changes to the tab fields (and a title taken from another tab), without the side effects of updateMeta. */
  setTabMeta(patch: Partial<Pick<DocumentMeta, "tabs" | "tabTitle" | "parentId" | "title" | "autoTitle" | "lastOpenedAt">>) {
    this.meta = { ...this.meta, ...patch };
    this.emit({ type: "meta", meta: this.meta });
    this.schedulePersist();
  }

  /** A new first-page thumbnail was saved. */
  setThumbnail(key: string) {
    this.meta = { ...this.meta, thumbnailAt: Date.now(), thumbnailKey: key };
    this.schedulePersist();
  }

  emitTabs(tabs: DocumentTab[]) {
    this.emit({ type: "tabs", tabs });
  }

  touch() {
    this.meta = { ...this.meta, lastOpenedAt: Date.now() };
    this.schedulePersist();
  }

  /** File the document in a folder, or at the top level (null). Not an edit, so the modified time stays. */
  setFolder(folderId: string | null) {
    const { folderId: _previous, ...rest } = this.meta;
    this.meta = folderId ? { ...rest, folderId } : rest;
    this.emit({ type: "meta", meta: this.meta });
    this.schedulePersist();
  }

  setTrashed(trashed: boolean) {
    this.meta = { ...this.meta, trashedAt: trashed ? Date.now() : null };
    this.emit({ type: "meta", meta: this.meta });
    this.schedulePersist();
  }

  // --- comments -------------------------------------------------------------

  addComment(input: { from: number; to: number; body: string; author: CommentAuthor }, origin: ChangeOrigin) {
    const id = newId(10);
    const quote = this.doc.textBetween(input.from, input.to, " ");
    const tr = new Transform(this.doc);
    tr.addMark(input.from, input.to, schema.mark("comment", { id }));
    const comment: DocComment = { id, author: input.author, body: input.body.trim(), quote, createdAt: Date.now(), resolved: false, replies: [] };
    this.comments = [...this.comments, comment];
    // Comments are not content changes; keep them out of the review hunks.
    this.applyTransform(tr, origin.kind === "agent" ? { kind: "system", label: "comment" } : origin, { hunks: mapHunks(this.hunks, tr.mapping) });
    this.emit({ type: "comments", comments: this.comments });
    this.schedulePersist();
    return comment;
  }

  replyToComment(id: string, body: string, author: CommentAuthor) {
    const comment = this.comments.find((item) => item.id === id);
    if (!comment) throw new Error(`No comment with id ${id}.`);
    const reply = { id: newId(10), author, body: body.trim(), createdAt: Date.now() };
    this.comments = this.comments.map((item) => (item.id === id ? { ...item, replies: [...item.replies, reply] } : item));
    this.emit({ type: "comments", comments: this.comments });
    this.schedulePersist();
    return reply;
  }

  setCommentResolved(id: string, resolved: boolean) {
    if (!this.comments.some((item) => item.id === id)) throw new Error(`No comment with id ${id}.`);
    this.comments = this.comments.map((item) => (item.id === id ? { ...item, resolved } : item));
    this.emit({ type: "comments", comments: this.comments });
    this.schedulePersist();
  }

  editComment(id: string, body: string) {
    this.comments = this.comments.map((item) => (item.id === id ? { ...item, body: body.trim() } : item));
    this.emit({ type: "comments", comments: this.comments });
    this.schedulePersist();
  }

  deleteComment(id: string) {
    this.comments = this.comments.filter((item) => item.id !== id);
    const tr = new Transform(this.doc);
    this.doc.descendants((node, pos) => {
      const mark = node.marks.find((m) => m.type.name === "comment" && m.attrs.id === id);
      if (mark) tr.removeMark(pos, pos + node.nodeSize, mark);
    });
    if (tr.docChanged) this.applyTransform(tr, { kind: "system", label: "comment" }, { hunks: mapHunks(this.hunks, tr.mapping) });
    this.emit({ type: "comments", comments: this.comments });
    this.schedulePersist();
  }

  /**
   * Lock text from Claude's edits, or unlock it. Locking isn't a content
   * change, so it never becomes a pending change for review.
   */
  setLocked(from: number, to: number, locked: boolean) {
    const tr = new Transform(this.doc);
    if (locked) tr.addMark(from, to, schema.mark("locked", { id: newId(10) }));
    else tr.removeMark(from, to, schema.marks.locked);
    if (!tr.docChanged) return false;
    return this.applyTransform(tr, { kind: "system", label: "lock" }, { hunks: mapHunks(this.hunks, tr.mapping) });
  }

  /** Locked passages and where they are. */
  lockedRanges() {
    return [...rangeMarkTexts(this.doc, "locked").values()];
  }

  /** Comments with the text they're currently anchored to. */
  commentsWithAnchors() {
    const anchors = rangeMarkTexts(this.doc, "comment");
    return this.comments.map((comment) => ({ ...comment, anchor: anchors.get(comment.id) ?? null }));
  }

  // --- activity & commands ----------------------------------------------------

  setActivity(activity: Omit<AgentActivity, "version" | "at"> | null) {
    this.activity = activity ? { ...activity, version: this.version, at: Date.now() } : null;
    this.emit({ type: "activity", activity: this.activity });
  }

  sendCommand(command: ClientCommand) {
    this.emit({ type: "command", command });
    return this.listeners.size;
  }

  setSelection(selection: { from: number; to: number; version: number }) {
    if (selection.version !== this.version) return;
    const max = this.doc.content.size;
    const from = Math.max(0, Math.min(max, selection.from));
    const to = Math.max(from, Math.min(max, selection.to));
    this.selection = { from, to, version: this.version, at: Date.now() };
  }

  setLayout(layout: PageFall & { version: number; settings?: string; kept?: PageFall }) {
    if (layout.version !== this.version) return;
    if (layout.settings !== undefined && layout.settings !== layoutKey(this.meta.settings)) return;
    const max = this.doc.content.size;
    const clean = (fall: PageFall): PageFall => ({ pages: fall.pages, starts: fall.starts.filter((pos) => pos <= max).sort((a, b) => a - b), lastPageFill: fall.lastPageFill });
    this.layout = {
      ...clean(layout),
      ...(layout.kept ? { kept: clean(layout.kept) } : {}),
      version: this.version,
      settings: layoutKey(this.meta.settings),
      words: docWordCount(this.doc),
      at: Date.now(),
    };
    for (const resolve of this.layoutWaiters) resolve();
    this.layoutWaiters.clear();
  }

  /** Whether the last reported layout is for the current text and page settings. */
  layoutIsCurrent() {
    return Boolean(this.layout && this.layout.version === this.version && this.layout.settings === layoutKey(this.meta.settings));
  }

  /**
   * The page layout for the current text. When an editor has the document open
   * but hasn't measured the latest change yet, wait a little for it to.
   */
  async currentLayout(timeoutMs = 2500): Promise<ClientLayout | null> {
    const fresh = () => (this.layoutIsCurrent() ? this.layout : null);
    if (fresh() || this.listeners.size === 0) return fresh();
    const deadline = Date.now() + timeoutMs;
    while (!fresh() && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.layoutWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
        this.layoutWaiters.add(done);
      });
    }
    return fresh();
  }

  // --- versions -------------------------------------------------------------

  async saveVersion(label: string, author: "user" | "claude" | "auto") {
    const version = {
      id: `${Date.now().toString(36)}-${newId(6)}`,
      documentId: this.id,
      label: label.trim() || "Saved version",
      createdAt: Date.now(),
      author,
      title: this.meta.title,
      doc: this.doc.toJSON(),
      wordCount: docWordCount(this.doc),
      ...(this.hunks.length ? { hunks: this.hunksJSON() } : {}),
    };
    await writeVersion(version);
    if (author === "auto") void pruneVersions(this.id).catch((error) => log("error", "pruning versions failed", { documentId: this.id, error }));
    this.dirtySinceVersion = false;
    this.lastAutoVersion = Date.now();
    this.lastVersionId = version.id;
    const { doc: _doc, hunks, ...summary } = version;
    return hunks?.length ? { ...summary, pendingChanges: hunks.length } : summary;
  }

  async versions(): Promise<VersionSummary[]> {
    return listVersions(this.id);
  }

  async restoreVersion(versionId: string) {
    const version = await readVersion(this.id, versionId);
    if (!version) throw new Error("Version not found.");
    await this.saveVersion("Before restoring a version", "auto");
    // Pending changes (Claude's and the user's suggestions) are kept in that version, so restoring it brings them back.
    const restored = loadDoc(version.doc);
    const tr = new Transform(this.doc);
    tr.replaceWith(0, this.doc.content.size, restored.content);
    const hunks = (version.hunks ?? []).flatMap((json) => {
      try {
        const hunk = hunkFromJSON(json, schema);
        return hunk.to <= tr.doc.content.size ? [hunk] : [];
      } catch {
        return [];
      }
    });
    if (!this.applyTransform(tr, { kind: "system", label: "restore" }, { hunks }) && hunks.length) {
      this.hunks = hunks;
      this.emit({ type: "hunks", version: this.version, hunks: this.hunksJSON() });
      this.schedulePersist();
    }
    return version;
  }

  /** Called before an agent turn edits the document, so the user can always go back. */
  /** Returns the id of a version holding the current content (a new one only when something changed since the last). */
  async checkpoint(label: string): Promise<string> {
    if (!this.dirtySinceVersion && this.lastVersionId) return this.lastVersionId;
    return (await this.saveVersion(label, "auto")).id;
  }

  // --- persistence ------------------------------------------------------------

  private schedulePersist() {
    if (this.deleted) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, PERSIST_DELAY_MS);
  }

  async persist() {
    if (this.deleted) return;
    this.meta = { ...this.meta, wordCount: docWordCount(this.doc), preview: docPreview(this.doc) };
    if (this.meta.autoTitle) {
      let firstLine = "";
      this.doc.descendants((node) => {
        if (firstLine) return false;
        if (node.isTextblock) {
          firstLine = node.textContent.trim();
          return false;
        }
        return true;
      });
      const title = titleFromText(firstLine);
      if (title && title !== this.meta.title) {
        this.meta = { ...this.meta, title };
        this.emit({ type: "meta", meta: this.meta });
        this.onRetitle?.(title);
      }
    }
    await writeDocumentFile(this.toFile());
    libraryChanged();
    if (this.dirtySinceVersion && Date.now() - this.lastAutoVersion > AUTO_VERSION_INTERVAL_MS) {
      await this.saveVersion("Autosave", "auto");
    }
  }

  async flush() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
  }

  toFile(): StoredDocumentFile {
    return { format: 3, meta: this.meta, doc: this.doc.toJSON(), comments: this.comments, hunks: this.hunksJSON() };
  }

  markDeleted() {
    this.deleted = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.emit({ type: "deleted" });
    this.listeners.clear();
  }

  resetEvent(): HubEvent {
    return { type: "reset", epoch: this.epoch, version: this.version, doc: this.doc.toJSON(), hunks: this.hunksJSON() };
  }
}

export function loadDoc(json: unknown): PMNode {
  try {
    const doc = PMNode.fromJSON(schema, json as Parameters<typeof PMNode.fromJSON>[1]);
    doc.check();
    return ensureBlockIds(doc);
  } catch {
    return ensureBlockIds(emptyDoc());
  }
}

// ---------------------------------------------------------------------------

/**
 * Whether `next` is exactly `previous` mapped through `tr`, with each change's
 * text untouched: then a client mapping the hunks through the same steps ends
 * up with the same list, and it needn't be sent again with every keystroke.
 */
function onlyMapped(before: PMNode, previous: readonly Hunk[], tr: Transform, next: readonly Hunk[]) {
  if (previous.length !== next.length) return false;
  for (let i = 0; i < previous.length; i += 1) {
    const old = previous[i]!;
    const hunk = next[i]!;
    if (hunk.id !== old.id || hunk.deleted !== old.deleted || hunk.author !== old.author || hunk.turn !== old.turn || hunk.createdAt !== old.createdAt) return false;
    const from = tr.mapping.map(old.from, 1);
    if (hunk.from !== from || hunk.to !== Math.max(from, tr.mapping.map(old.to, -1))) return false;
    if (tr.doc.textBetween(hunk.from, hunk.to, "\n") !== before.textBetween(old.from, old.to, "\n")) return false;
  }
  return true;
}

/** The first 240 characters of the text, read only as far as needed. */
function docPreview(doc: PMNode) {
  let text = "";
  doc.forEach((child) => {
    if (text.length > 480) return;
    text += `${child.isText ? child.text : child.textBetween(0, child.content.size, "\n\n", (node) => (node.type.name === "hard_break" ? "\n" : ""))}\n\n`;
  });
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

export type CreateDocumentInput = {
  title?: string;
  markdown?: string;
  doc?: unknown;
  settings?: Partial<DocumentSettings> | unknown;
  comments?: DocComment[];
  /** Creates a tab of this document (the first tab's id) instead of a document of its own. */
  parentId?: string;
  tabTitle?: string;
  /** The folder to file the new document in. */
  folderId?: string | null;
};

class DocumentHub {
  private metas = new FileSummaryCache<DocumentMeta>();
  private open = new Map<string, LiveDocument>();
  private loading = new Map<string, Promise<LiveDocument | null>>();
  /** The document most recently focused in a browser tab; the default target for MCP tools. */
  activeDocumentId: string | null = null;

  async get(id: string): Promise<LiveDocument | null> {
    this.scheduleSweep();
    const existing = this.open.get(id);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    const pending = this.loading.get(id);
    if (pending) return pending;
    const load = (async () => {
      const file = await readDocumentFile(id).catch(() => null);
      if (!file) return null;
      const live = this.adopt(new LiveDocument(normalizeFile(file)));
      this.open.set(id, live);
      return live;
    })();
    this.loading.set(id, load);
    try {
      return await load;
    } finally {
      this.loading.delete(id);
    }
  }

  async require(id: string): Promise<LiveDocument> {
    const doc = await this.get(id);
    if (!doc || doc.meta.trashedAt) throw new Error(`Document ${id} was not found.`);
    return doc;
  }

  async create(input: CreateDocumentInput = {}): Promise<LiveDocument> {
    const now = Date.now();
    let doc: PMNode;
    if (input.doc) doc = loadDoc(input.doc);
    else if (input.markdown?.trim()) doc = ensureBlockIds(markdownToDoc(input.markdown));
    else doc = ensureBlockIds(emptyDoc());
    const text = docPlainText(doc);
    const meta: DocumentMeta = {
      id: newId(12),
      title: cleanTitle(input.title),
      autoTitle: !input.parentId && (!input.title || /^untitled\b/i.test(input.title.trim())),
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      trashedAt: null,
      settings: normalizeSettings(input.settings ?? DEFAULT_SETTINGS),
      wordCount: wordCount(text),
      preview: text.replace(/\s+/g, " ").trim().slice(0, 240),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.tabTitle ? { tabTitle: cleanTabTitle(input.tabTitle) } : {}),
      ...(input.folderId && !input.parentId ? { folderId: input.folderId } : {}),
    };
    const live = new LiveDocument({ format: 3, meta, doc: doc.toJSON(), comments: input.comments ?? [], hunks: [] });
    this.adopt(live);
    this.open.set(meta.id, live);
    await writeDocumentFile(live.toFile());
    libraryChanged();
    return live;
  }

  private adopt(live: LiveDocument) {
    live.onRetitle = (title) => void this.shareTitle(live, title).catch((error) => log("error", "a title couldn't be copied to the other tabs", { documentId: live.id, error }));
    return live;
  }

  // --- tabs -------------------------------------------------------------------

  /**
   * A document's tabs in order. The root (the tab the document was created
   * with) holds the title and the order, which may put it anywhere.
   */
  async family(id: string): Promise<{ root: LiveDocument; tabs: LiveDocument[] }> {
    const doc = await this.require(id);
    const root = (doc.meta.parentId && (await this.get(doc.meta.parentId))) || doc;
    const order = tabOrder(root.meta);
    const members = await Promise.all(order.map((member) => (member === root.id ? root : this.get(member))));
    const tabs = members.filter((member): member is LiveDocument => Boolean(member && (member === root || (!member.meta.trashedAt && member.meta.parentId === root.id))));
    return { root, tabs };
  }

  async tabs(id: string): Promise<DocumentTab[]> {
    const { root, tabs } = await this.family(id);
    return listTabs(root, tabs);
  }

  async createTab(id: string, input: { title?: string; markdown?: string } = {}) {
    const { root, tabs } = await this.family(id);
    const names = new Set(tabs.map((tab, index) => tabTitle(tab.meta, index)));
    let n = tabs.length + 1;
    while (names.has(`Tab ${n}`)) n += 1;
    const tab = await this.create({
      title: root.meta.title,
      markdown: input.markdown,
      settings: root.meta.settings,
      parentId: root.id,
      tabTitle: input.title?.trim() || `Tab ${n}`,
    });
    // Name the root's tab too, so its name doesn't change when tabs move.
    root.setTabMeta({ tabs: [...tabs.map((item) => item.id), tab.id], ...(root.meta.tabTitle ? {} : { tabTitle: tabTitle(root.meta, tabs.indexOf(root)) }) });
    await this.announceTabs(root.id);
    return tab;
  }

  async renameTab(id: string, title: string) {
    const doc = await this.require(id);
    doc.setTabMeta({ tabTitle: cleanTabTitle(title) });
    await this.announceTabs(id);
  }

  /**
   * Deletes a tab for good; a document keeps at least one. Deleting the root
   * hands the title and tab order to the next tab. Returns the root afterwards.
   */
  async deleteTab(id: string): Promise<LiveDocument> {
    const { root, tabs } = await this.family(id);
    if (tabs.length < 2) throw new Error("A document needs at least one tab.");
    const order = tabs.map((tab) => tab.id).filter((item) => item !== id);
    let next = root;
    if (id === root.id) {
      next = tabs.find((tab) => tab.id !== id)!;
      next.setTabMeta({ parentId: undefined, tabs: order, title: root.meta.title, autoTitle: root.meta.autoTitle, lastOpenedAt: Math.max(root.meta.lastOpenedAt, next.meta.lastOpenedAt) });
      for (const tab of tabs) if (tab !== root && tab !== next) tab.setTabMeta({ parentId: next.id });
      root.setTabMeta({ tabs: undefined });
    } else {
      root.setTabMeta({ tabs: order });
    }
    await this.remove(id);
    await this.announceTabs(next.id);
    return next;
  }

  /** Moves a tab to a new position (0 is first). */
  async moveTab(id: string, index: number) {
    const { root, tabs } = await this.family(id);
    const order = tabs.map((item) => item.id).filter((item) => item !== id);
    order.splice(Math.max(0, Math.min(order.length, index)), 0, id);
    root.setTabMeta({ tabs: order });
    await this.announceTabs(root.id);
  }

  private async announceTabs(id: string) {
    const { root, tabs } = await this.family(id);
    const list = listTabs(root, tabs);
    for (const tab of tabs) tab.emitTabs(list);
  }

  /** Every tab shows the document's one title. */
  private async shareTitle(source: LiveDocument, title: string) {
    if (!source.meta.parentId && !source.meta.tabs?.length) return;
    const { root, tabs } = await this.family(source.id);
    if (source !== root && root.meta.title !== title) root.updateMeta({ title });
    for (const tab of tabs) if (tab !== source && tab !== root && tab.meta.title !== title) tab.setTabMeta({ title });
  }

  /** Delete every document in the trash. Nothing leaves the trash any other way: it's kept until the user empties it or deletes it. */
  async emptyTrash() {
    const trashed = await this.list({ trashed: true });
    for (const meta of trashed) await this.remove(meta.id);
    return trashed.length;
  }

  /** Every document's meta, tabs and trashed ones included. Documents that aren't open are read only when their file changed since last time. */
  async allMetas(): Promise<DocumentMeta[]> {
    const ids = await listDocumentIds();
    const listed = await Promise.all(
      ids.map(async (id) => {
        const live = this.open.get(id);
        if (live) return live.meta;
        return this.metas.get(documentFilePath(id), async () => {
          const file = await readDocumentFile(id).catch((error) => {
            log("error", "a document file couldn't be read; it is left out of the list", { documentId: id, error });
            return null;
          });
          return file ? normalizeFile(file).meta : null;
        });
      }),
    );
    return listed.filter((meta): meta is DocumentMeta => Boolean(meta));
  }

  async list(options: { trashed?: boolean } = {}): Promise<DocumentMeta[]> {
    const metas = await this.allMetas();
    return metas
      .filter((meta) => !meta.parentId && (options.trashed ? Boolean(meta.trashedAt) : !meta.trashedAt))
      .sort((a, b) => Math.max(b.lastOpenedAt, b.updatedAt) - Math.max(a.lastOpenedAt, a.updatedAt));
  }

  async duplicate(id: string): Promise<LiveDocument> {
    const { root: source, tabs } = await this.family(id);
    const copy = await this.create({
      title: `${source.meta.title} (copy)`,
      doc: source.doc.toJSON(),
      settings: source.meta.settings,
      folderId: source.meta.folderId,
    });
    if (source.meta.tabTitle) copy.setTabMeta({ tabTitle: source.meta.tabTitle });
    if (tabs.length > 1) {
      const order: string[] = [];
      for (const tab of tabs) {
        if (tab === source) order.push(copy.id);
        else order.push((await this.create({ title: copy.meta.title, doc: tab.doc.toJSON(), settings: tab.meta.settings, parentId: copy.id, tabTitle: tab.meta.tabTitle })).id);
      }
      copy.setTabMeta({ tabs: order });
    }
    return copy;
  }

  async remove(id: string) {
    const live = await this.get(id);
    // Deleting a document deletes its other tabs too.
    for (const child of live?.meta.tabs ?? []) if (child !== id) await this.remove(child);
    live?.markDeleted();
    this.open.delete(id);
    await deleteDocumentFile(id);
    libraryChanged();
    if (this.activeDocumentId === id) this.activeDocumentId = null;
  }

  async active(): Promise<LiveDocument | null> {
    if (this.activeDocumentId) {
      const doc = await this.get(this.activeDocumentId);
      if (doc && !doc.meta.trashedAt) return doc;
    }
    const [latest] = await this.list();
    return latest ? this.get(latest.id) : null;
  }

  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  private scheduleSweep() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => void this.unloadIdle(), SWEEP_INTERVAL_MS);
    // Housekeeping only: it must not keep the process alive.
    this.sweepTimer.unref?.();
  }

  /**
   * Unload documents nobody has watched or changed for a while; they're read
   * back from disk on next use. Open tabs reconnect to a new epoch, which
   * they handle like a server restart.
   */
  async unloadIdle(maxIdleMs = UNLOAD_AFTER_MS, now = Date.now()) {
    let unloaded = 0;
    for (const [id, doc] of this.open) {
      if (!doc.idle || now - doc.lastUsed < maxIdleMs || doc.activity) continue;
      await doc.flush().catch(() => undefined);
      // Check again: it may have been used while saving.
      if (!doc.idle || now - doc.lastUsed < maxIdleMs) continue;
      this.open.delete(id);
      unloaded += 1;
    }
    return unloaded;
  }

  get loadedCount() {
    return this.open.size;
  }

  async flushAll() {
    await Promise.all([...this.open.values()].map((doc) => doc.flush().catch(() => undefined)));
  }
}

function normalizeFile(file: StoredDocumentFile): StoredDocumentFile {
  const meta = file.meta;
  return {
    format: 3,
    meta: {
      id: meta.id,
      title: cleanTitle(meta.title),
      createdAt: meta.createdAt ?? Date.now(),
      updatedAt: meta.updatedAt ?? Date.now(),
      lastOpenedAt: meta.lastOpenedAt ?? meta.updatedAt ?? Date.now(),
      trashedAt: meta.trashedAt ?? null,
      settings: normalizeSettings(meta.settings),
      wordCount: meta.wordCount ?? 0,
      preview: meta.preview ?? "",
      autoTitle: meta.autoTitle ?? false,
      ...(typeof meta.parentId === "string" ? { parentId: meta.parentId } : {}),
      ...(Array.isArray(meta.tabs) && meta.tabs.length ? { tabs: meta.tabs.filter((item): item is string => typeof item === "string") } : {}),
      ...(typeof meta.tabTitle === "string" && meta.tabTitle.trim() ? { tabTitle: meta.tabTitle } : {}),
      ...(typeof meta.folderId === "string" && meta.folderId ? { folderId: meta.folderId } : {}),
      ...(typeof meta.thumbnailAt === "number" ? { thumbnailAt: meta.thumbnailAt, thumbnailKey: String(meta.thumbnailKey ?? "") } : {}),
    },
    doc: file.doc,
    comments: Array.isArray(file.comments) ? file.comments : [],
    hunks: Array.isArray(file.hunks) ? file.hunks : [],
  };
}

export function tabTitle(meta: DocumentMeta, index: number) {
  return meta.tabTitle || `Tab ${index + 1}`;
}

/** Every tab's id in order; older files list only the tabs after the root. */
function tabOrder(root: DocumentMeta) {
  const tabs = root.tabs ?? [];
  return tabs.includes(root.id) ? tabs : [root.id, ...tabs];
}

function listTabs(root: LiveDocument, tabs: LiveDocument[]): DocumentTab[] {
  return tabs.map((tab, index) => ({ id: tab.id, title: tabTitle(tab.meta, index), ...(tab === root ? { root: true } : {}), outline: docOutline(tab.doc) }));
}

/** A tab's title and headings, as the tabs pane lists them. */
export function docOutline(doc: PMNode): TabHeading[] {
  const entries: TabHeading[] = [];
  doc.forEach((node, pos) => {
    const level = node.type.name === "title" ? 0 : node.type.name === "heading" ? (node.attrs.level as number) : 9;
    const text = node.textContent.trim();
    if (level <= 4 && text) entries.push({ pos, level, text: text.slice(0, 120) });
  });
  return entries.slice(0, 200);
}

function cleanTabTitle(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 100) || "Untitled tab";
}

const globalForHub = globalThis as unknown as { __inlineHub?: DocumentHub; __inlineHubExitHook?: boolean };

export function documentHub(): DocumentHub {
  if (!globalForHub.__inlineHub) {
    globalForHub.__inlineHub = new DocumentHub();
    // Bring the Word copies on disk up to date once the server is first used. This runs from a
    // request, not a startup hook: code loaded at startup is bundled apart from the routes, and a
    // hub made there would hold documents built from a different copy of the schema.
    libraryChanged();
  }
  if (!globalForHub.__inlineHubExitHook) {
    globalForHub.__inlineHubExitHook = true;
    const flush = () => {
      void globalForHub.__inlineHub?.flushAll();
    };
    process.once("beforeExit", flush);
    process.once("SIGINT", () => {
      void globalForHub.__inlineHub?.flushAll().finally(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
      void globalForHub.__inlineHub?.flushAll().finally(() => process.exit(0));
    });
  }
  return globalForHub.__inlineHub;
}

export type { DocumentHub };

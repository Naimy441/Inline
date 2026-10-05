import { Node as PMNode } from "prosemirror-model";
import { Step, Transform } from "prosemirror-transform";
import { docPlainText, rangeMarkTexts, wordCount } from "@/lib/doc/editing";
import { blockIdFixes, ensureBlockIds, newId } from "@/lib/doc/ids";
import { markdownToDoc } from "@/lib/doc/markdown";
import { acceptHunks, hunkFromJSON, hunkToJSON, mapHunks, recordAgentChange, rejectHunks, USER_AUTHOR, type Hunk, type HunkJSON } from "@/lib/doc/review";
import { emptyDoc, schema } from "@/lib/doc/schema";
import {
  DEFAULT_SETTINGS,
  cleanTitle,
  normalizeSettings,
  titleFromText,
  patchSettings,
  type CommentAuthor,
  type DocComment,
  type DocumentMeta,
  type DocumentSettings,
} from "@/lib/doc/settings";
import {
  deleteDocumentFile,
  listDocumentIds,
  listVersions,
  readDocumentFile,
  readVersion,
  writeDocumentFile,
  writeVersion,
  type StoredDocumentFile,
  type VersionSummary,
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
  | { kind: "export_pdf" }
  | { kind: "open_document"; documentId: string }
  | { kind: "scroll_to"; from: number; to: number; version: number }
  | { kind: "download"; url: string; filename: string };

export type HubEvent =
  | { type: "steps"; version: number; steps: unknown[]; clientIDs: string[]; hunks?: HunkJSON[] }
  | { type: "hunks"; version: number; hunks: HunkJSON[] }
  | { type: "meta"; meta: DocumentMeta }
  | { type: "comments"; comments: DocComment[] }
  | { type: "reset"; epoch: string; version: number; doc: unknown; hunks: HunkJSON[] }
  | { type: "activity"; activity: AgentActivity | null }
  | { type: "command"; command: ClientCommand }
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

const STEP_LOG_LIMIT = 2000;
const PERSIST_DELAY_MS = 400;
const AUTO_VERSION_INTERVAL_MS = 10 * 60 * 1000;

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
  /** The mode the user's editor is in, so Claude knows whether they're suggesting or only viewing. */
  editorMode: "editing" | "suggesting" | "viewing" = "editing";
  private log: Array<{ step: Step; clientID: string }> = [];
  private listeners = new Set<(event: HubEvent) => void>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAutoVersion = 0;
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
    return () => this.listeners.delete(listener);
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
    const hunksChanged = hunks.length !== this.hunks.length || hunks.some((hunk, i) => hunk !== this.hunks[i]) || this.hunks.length > 0;
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

  // --- meta -----------------------------------------------------------------

  updateMeta(patch: { title?: string; settings?: unknown }) {
    const next = { ...this.meta };
    if (patch.title !== undefined) {
      next.title = cleanTitle(patch.title);
      next.autoTitle = false;
    }
    if (patch.settings !== undefined) next.settings = patchSettings(this.meta.settings, patch.settings);
    next.updatedAt = Date.now();
    this.meta = next;
    this.emit({ type: "meta", meta: this.meta });
    this.schedulePersist();
    return this.meta;
  }

  touch() {
    this.meta = { ...this.meta, lastOpenedAt: Date.now() };
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
      wordCount: wordCount(docPlainText(this.doc)),
      ...(this.hunks.length ? { hunks: this.hunksJSON() } : {}),
    };
    await writeVersion(version);
    this.dirtySinceVersion = false;
    this.lastAutoVersion = Date.now();
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
  async checkpoint(label: string) {
    if (!this.dirtySinceVersion && this.lastAutoVersion) return null;
    return this.saveVersion(label, "auto");
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
    const text = docPlainText(this.doc);
    this.meta = { ...this.meta, wordCount: wordCount(text), preview: text.replace(/\s+/g, " ").trim().slice(0, 240) };
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
      }
    }
    await writeDocumentFile(this.toFile());
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

export type CreateDocumentInput = {
  title?: string;
  markdown?: string;
  doc?: unknown;
  settings?: Partial<DocumentSettings> | unknown;
  comments?: DocComment[];
};

class DocumentHub {
  private open = new Map<string, LiveDocument>();
  private loading = new Map<string, Promise<LiveDocument | null>>();
  /** The document most recently focused in a browser tab; the default target for MCP tools. */
  activeDocumentId: string | null = null;

  async get(id: string): Promise<LiveDocument | null> {
    const existing = this.open.get(id);
    if (existing) return existing;
    const pending = this.loading.get(id);
    if (pending) return pending;
    const load = (async () => {
      const file = await readDocumentFile(id).catch(() => null);
      if (!file) return null;
      const live = new LiveDocument(normalizeFile(file));
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
      autoTitle: !input.title || /^untitled\b/i.test(input.title.trim()),
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      trashedAt: null,
      settings: normalizeSettings(input.settings ?? DEFAULT_SETTINGS),
      wordCount: wordCount(text),
      preview: text.replace(/\s+/g, " ").trim().slice(0, 240),
    };
    const live = new LiveDocument({ format: 3, meta, doc: doc.toJSON(), comments: input.comments ?? [], hunks: [] });
    this.open.set(meta.id, live);
    await writeDocumentFile(live.toFile());
    return live;
  }

  async list(options: { trashed?: boolean } = {}): Promise<DocumentMeta[]> {
    const ids = await listDocumentIds();
    const metas: DocumentMeta[] = [];
    for (const id of ids) {
      const live = this.open.get(id);
      if (live) {
        metas.push(live.meta);
        continue;
      }
      const file = await readDocumentFile(id).catch(() => null);
      if (file) metas.push(normalizeFile(file).meta);
    }
    return metas
      .filter((meta) => (options.trashed ? Boolean(meta.trashedAt) : !meta.trashedAt))
      .sort((a, b) => Math.max(b.lastOpenedAt, b.updatedAt) - Math.max(a.lastOpenedAt, a.updatedAt));
  }

  async duplicate(id: string): Promise<LiveDocument> {
    const source = await this.require(id);
    return this.create({
      title: `${source.meta.title} (copy)`,
      doc: source.doc.toJSON(),
      settings: source.meta.settings,
    });
  }

  async remove(id: string) {
    const live = await this.get(id);
    live?.markDeleted();
    this.open.delete(id);
    await deleteDocumentFile(id);
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
    },
    doc: file.doc,
    comments: Array.isArray(file.comments) ? file.comments : [],
    hunks: Array.isArray(file.hunks) ? file.hunks : [],
  };
}

const globalForHub = globalThis as unknown as { __inlineHub?: DocumentHub; __inlineHubExitHook?: boolean };

export function documentHub(): DocumentHub {
  if (!globalForHub.__inlineHub) globalForHub.__inlineHub = new DocumentHub();
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

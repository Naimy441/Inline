"use client";

import { getVersion, receiveTransaction, sendableSteps } from "prosemirror-collab";
import { Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection, type Command, type Transaction } from "prosemirror-state";
import { Step } from "prosemirror-transform";
import { dataUrlToBlob, ImageView } from "@/lib/editor/imageView";
import { EditorView } from "prosemirror-view";
import type { HunkJSON } from "@/lib/doc/review";
import { schema } from "@/lib/doc/schema";
import { pageSize, type DocComment, type DocumentMeta } from "@/lib/doc/settings";
import { api, ApiError, post, Store, uploadFile } from "@/lib/client/api";
import { setCommentState } from "@/lib/editor/comments";
import { syncDomSelection } from "@/lib/editor/domSync";
import { pageCount, relayout, type PageGeometry } from "@/lib/editor/pagination";
import { setPresence } from "@/lib/editor/presence";
import { gotoHunk, mapHunksThrough, reviewHunkAtCursor, setHunks } from "@/lib/editor/review";
import { editorPlugins } from "@/lib/editor/setup";
import { snapshotPages } from "@/lib/pdf/pageSnapshot";
import { buildPdf } from "@/lib/pdf/pdfWriter";
import { setInvisibles } from "@/lib/editor/invisibles";
import { rebaseLocalEdits, unconfirmedEdits } from "@/lib/editor/resync";
import { loadPreferences, preferences, setPreference } from "@/lib/client/preferences";

/**
 * The browser side of a live document. The server is the authority
 * (prosemirror-collab): local edits apply instantly and are sent as steps;
 * steps from the server (Claude's edits, other tabs, review actions) arrive
 * over Server-Sent Events and are rebased under any unconfirmed local work.
 */

export type AgentActivity = {
  chatId: string;
  status: "reading" | "editing" | "thinking" | "idle";
  label: string;
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

type Snapshot = { meta: DocumentMeta; epoch?: string; doc: unknown; version: number; comments: DocComment[]; hunks: HunkJSON[]; activity: AgentActivity | null };

type ServerEvent =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "reset"; epoch?: string; version: number; doc: unknown; hunks: HunkJSON[] }
  | { type: "steps"; version: number; steps: unknown[]; clientIDs: string[]; hunks?: HunkJSON[] }
  | { type: "hunks"; version: number; hunks: HunkJSON[] }
  | { type: "meta"; meta: DocumentMeta }
  | { type: "comments"; comments: DocComment[] }
  | { type: "activity"; activity: AgentActivity | null }
  | { type: "command"; command: ClientCommand }
  | { type: "deleted" };

export type DocumentUiState = {
  status: "loading" | "ready" | "error" | "deleted";
  error?: string;
  meta: DocumentMeta | null;
  comments: DocComment[];
  hunks: HunkJSON[];
  activity: AgentActivity | null;
  connection: "connecting" | "live" | "reconnecting";
  sync: "saved" | "saving" | "error";
  pages: number;
  activeComment: string | null;
  /**
   * Local edits that couldn't be merged after the server's copy changed underneath them
   * (for example after a server restart). Kept so the user can recover them as a new document.
   */
  unmerged: { doc: unknown; steps: number } | null;
  /** Set while the browser print dialog is open: pages are laid out with no gap between them. */
  printing: boolean;
  /** Set while a PDF is being drawn from the page layout. */
  exporting: boolean;
  /** Phones: text reflows to the screen instead of sitting on fixed-size pages. Printing and export still use pages. */
  flow: boolean;
  /** Editing changes the document directly; suggesting records edits for review; viewing is read-only. */
  mode: EditorMode;
};

export type EditorMode = "editing" | "suggesting" | "viewing";

const MODES: readonly EditorMode[] = ["editing", "suggesting", "viewing"];

const PX_PER_IN = 96;

export function geometryFor(meta: DocumentMeta | null): PageGeometry & { pageWidth: number; marginLeft: number; marginRight: number } {
  const settings = meta?.settings;
  const size = settings ? pageSize(settings.pageSetup) : { width: 8.5, height: 11 };
  const margins = settings?.pageSetup.margins ?? { top: 1, right: 1, bottom: 1, left: 1 };
  return {
    pageWidth: size.width * PX_PER_IN,
    pageHeight: size.height * PX_PER_IN,
    marginTop: margins.top * PX_PER_IN,
    marginBottom: margins.bottom * PX_PER_IN,
    marginLeft: margins.left * PX_PER_IN,
    marginRight: margins.right * PX_PER_IN,
    gap: 24,
  };
}

/** Effectively endless: reflowed text is one long page. */
const FLOW_PAGE_HEIGHT = 10_000_000;

function nextFrames(count: number) {
  return new Promise<void>((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(count);
  });
}

/** Resolve once pagination has produced the same page count for a few frames in a row. */
function settleLayout(pages: () => number) {
  return new Promise<void>((resolve) => {
    let last = -1;
    let stable = 0;
    let frames = 0;
    const tick = () => {
      const current = pages();
      stable = current === last ? stable + 1 : 0;
      last = current;
      frames += 1;
      if (stable >= 3 || frames > 30) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function randomClientId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return `c${Array.from(bytes, (byte) => byte.toString(36)).join("").slice(0, 14)}`;
}

export type SessionCallbacks = {
  onCommand?: (command: ClientCommand) => void;
  onKeyCommand?: (name: "link" | "find" | "replace" | "comment" | "askClaude") => boolean;
};

export class DocumentSession {
  readonly ui = new Store<DocumentUiState>({
    status: "loading",
    meta: null,
    comments: [],
    hunks: [],
    activity: null,
    connection: "connecting",
    sync: "saved",
    pages: 1,
    activeComment: null,
    unmerged: null,
    printing: false,
    exporting: false,
    flow: false,
    mode: "editing",
  });
  /** Bumped on every editor transaction so toolbars can re-read the state. */
  readonly editor = new Store<EditorState | null>(null);
  view: EditorView | null = null;
  private source: EventSource | null = null;
  private readonly clientID = randomClientId();
  private inflight = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private selectionTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private generation = 0;
  /** The server's load of this document that our version numbers belong to. */
  private epoch: string | null = null;
  private confirmWaiters: Array<() => void> = [];
  /** Whether the steps now being typed are suggestions. Lags `ui.mode` until earlier edits are confirmed. */
  private suggesting = false;

  constructor(
    readonly id: string,
    private callbacks: SessionCallbacks = {},
  ) {}

  get meta() {
    return this.ui.get().meta;
  }

  /** Page geometry for the current settings; sheets touch while printing so each sheet is one printed page. */
  geometry() {
    const geometry = geometryFor(this.meta);
    const ui = this.ui.get();
    if (ui.printing) return { ...geometry, gap: 0 };
    // Reflowed text has no pages to break across.
    if (ui.flow && !ui.exporting) return { ...geometry, pageHeight: FLOW_PAGE_HEIGHT, marginTop: 0, marginBottom: 0, gap: 0 };
    return geometry;
  }

  /** Switch between pages and reflowed text (phones). */
  setFlow(flow: boolean) {
    if (this.ui.get().flow === flow) return;
    this.ui.set((ui) => ({ ...ui, flow }));
    if (this.view) relayout(this.view);
  }

  /**
   * Print (or save as PDF) exactly what's on screen: lay the sheets out
   * edge to edge, size the printed page to the document's paper, print, then
   * restore the normal layout.
   */
  async print() {
    const view = this.view;
    if (!view || this.ui.get().printing) return;
    const geometry = geometryFor(this.meta);
    const style = document.createElement("style");
    style.textContent = `@page { size: ${geometry.pageWidth / 96}in ${geometry.pageHeight / 96}in; margin: 0; }`;
    document.head.append(style);
    this.ui.set((ui) => ({ ...ui, printing: true }));
    // Reflowed (phone) layouts switch to pages first; let React draw them.
    if (this.ui.get().flow) await nextFrames(2);
    relayout(view);
    await settleLayout(() => pageCount(view.state));
    try {
      window.print();
    } finally {
      style.remove();
      this.ui.set((ui) => ({ ...ui, printing: false }));
      if (this.view) relayout(this.view);
    }
  }

  /**
   * Download a PDF drawn from the laid-out pages (lib/pdf), so breaks, margins,
   * headers and wrapping match the screen. Review marks and other editor UI are
   * left out.
   */
  async exportPdf() {
    const view = this.view;
    if (!view) throw new Error("The document isn't open yet.");
    await this.whenSaved();
    const root = view.dom.closest<HTMLElement>(".page-stack");
    if (!root) throw new Error("The page layout isn't ready yet.");
    const title = this.meta?.title ?? "Untitled document";
    // Lay the pages out without review marks (as printing does) while they're read.
    root.classList.add("is-clean");
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      if (this.ui.get().flow) {
        this.ui.set((ui) => ({ ...ui, exporting: true }));
        await nextFrames(2);
      }
      relayout(view);
      await settleLayout(() => pageCount(view.state));
      bytes = buildPdf(snapshotPages(root, title));
    } finally {
      root.classList.remove("is-clean");
      if (this.ui.get().exporting) {
        this.ui.set((ui) => ({ ...ui, exporting: false }));
        await nextFrames(1);
      }
      if (this.view) relayout(this.view);
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Untitled document"}.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async start(mount: HTMLElement) {
    // React may mount, unmount and remount the canvas (Strict Mode, Fast Refresh);
    // only the latest start() wins.
    const generation = ++this.generation;
    this.destroyed = false;
    try {
      const { document } = await api<{ document: Snapshot }>(`/api/documents/${this.id}`);
      if (this.destroyed || generation !== this.generation) return;
      this.epoch = document.epoch ?? null;
      const mode = this.storedMode();
      this.suggesting = mode === "suggesting";
      this.ui.set((ui) => ({ ...ui, mode }));
      this.view = new EditorView(mount, {
        editable: () => this.ui.get().mode !== "viewing",
        state: this.createState(document),
        dispatchTransaction: (tr) => this.dispatch(tr),
        nodeViews: { image: (node, view, getPos) => new ImageView(node, view, getPos) },
        attributes: { class: "doc-content", spellcheck: "true", "aria-label": "Document", role: "textbox", "aria-multiline": "true" },
        handleDOMEvents: {
          focus: () => {
            this.reportSelection();
            return false;
          },
        },
      });
      this.applySnapshotUi(document);
      window.addEventListener("beforeunload", this.onBeforeUnload);
      this.ui.set((ui) => ({ ...ui, status: "ready" }));
      this.editor.set(this.view.state);
      this.connect();
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) this.ui.set((ui) => ({ ...ui, status: "error", error: "This document doesn't exist or was deleted." }));
      else this.ui.set((ui) => ({ ...ui, status: "error", error: error instanceof Error ? error.message : "Couldn't open the document." }));
    }
  }

  /** Ask before leaving while edits are still on their way to the server. */
  private onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (this.view && sendableSteps(this.view.state)) event.preventDefault();
  };

  destroy() {
    this.destroyed = true;
    window.removeEventListener("beforeunload", this.onBeforeUnload);
    this.source?.close();
    for (const timer of [this.retryTimer, this.selectionTimer, this.reconnectTimer]) if (timer) clearTimeout(timer);
    this.view?.destroy();
    this.view = null;
  }

  private createState(snapshot: { doc: unknown; version: number; hunks: HunkJSON[] }) {
    const doc = PMNode.fromJSON(schema, snapshot.doc as Parameters<typeof PMNode.fromJSON>[1]);
    const state = EditorState.create({
      doc,
      plugins: editorPlugins({
        version: snapshot.version,
        clientID: this.clientID,
        review: { review: (action, ids) => void this.review(action, ids) },
        onActivateComment: (id) => this.setActiveComment(id),
        geometry: () => this.geometry(),
        onPages: (pages) => this.ui.set((ui) => (ui.pages === pages ? ui : { ...ui, pages })),
        keys: this.keyBindings(),
        readOnly: () => this.ui.get().mode === "viewing",
        substitutions: () => preferences.get().substitutions,
        showInvisibles: loadPreferences().showInvisibles,
      }),
    });
    return state.apply(setHunks(state.tr, snapshot.hunks, snapshot.version));
  }

  private keyBindings(): Record<string, Command> {
    // A shortcut pressed right after Shift+End can arrive before the browser's
    // selectionchange, so read the DOM selection first or the command sees an
    // empty range.
    const delegate = (name: "link" | "find" | "replace" | "comment" | "askClaude"): Command => () => {
      if (this.view) syncDomSelection(this.view);
      return this.callbacks.onKeyCommand?.(name) ?? false;
    };
    return {
      "Mod-k": delegate("link"),
      "Mod-h": delegate("replace"),
      "Mod-Alt-m": delegate("comment"),
      "Mod-Shift-Enter": (_state, dispatch, view) => (dispatch && view ? reviewHunkAtCursor(view, "accept", { review: (a, ids) => void this.review(a, ids) }) : true),
      "Mod-Shift-Backspace": (_state, dispatch, view) => (dispatch && view ? reviewHunkAtCursor(view, "reject", { review: (a, ids) => void this.review(a, ids) }) : true),
      "Alt-]": (_state, dispatch, view) => (dispatch && view ? this.gotoChange(1) : true),
      "Alt-[": (_state, dispatch, view) => (dispatch && view ? this.gotoChange(-1) : true),
    };
  }

  private applySnapshotUi(snapshot: Snapshot) {
    this.ui.set((ui) => ({
      ...ui,
      meta: snapshot.meta,
      comments: snapshot.comments,
      hunks: snapshot.hunks,
      activity: snapshot.activity,
    }));
    this.syncCommentPlugin(snapshot.comments);
    this.applyActivity(snapshot.activity);
  }

  // --- transactions ----------------------------------------------------------------

  dispatch(tr: Transaction) {
    const view = this.view;
    if (!view) return;
    const state = view.state.apply(tr);
    view.updateState(state);
    this.editor.set(state);
    if (tr.docChanged) {
      this.updateSync();
      this.flushSteps();
    }
    if (tr.selectionSet || tr.docChanged) this.scheduleSelectionReport();
  }

  private updateSync() {
    const view = this.view;
    if (!view) return;
    const pending = sendableSteps(view.state);
    const sync = pending ? "saving" : "saved";
    if (this.ui.get().sync !== sync && this.ui.get().sync !== "error") this.ui.set((ui) => ({ ...ui, sync }));
    else if (!pending && this.ui.get().sync === "error") this.ui.set((ui) => ({ ...ui, sync: "saved" }));
    if (!pending) {
      for (const resolve of this.confirmWaiters.splice(0)) resolve();
    }
  }

  private flushSteps() {
    const view = this.view;
    if (!view || this.inflight) return;
    const sendable = sendableSteps(view.state);
    if (!sendable) return;
    this.inflight = true;
    const body = {
      version: sendable.version,
      steps: sendable.steps.map((step) => step.toJSON()),
      clientID: String(sendable.clientID),
      ...(this.epoch ? { epoch: this.epoch } : {}),
      ...(this.suggesting ? { suggest: true } : {}),
    };
    post<{ version: number }>(`/api/documents/${this.id}/steps`, body)
      .then(() => {
        this.inflight = false;
        // Confirmation arrives through the event stream along with everyone else's
        // steps. If it already came while this request was in flight, the flush it
        // triggered was skipped, so send whatever was typed since now.
        const current = this.view;
        if (current && getVersion(current.state) >= body.version + body.steps.length) this.flushSteps();
      })
      .catch((error: unknown) => {
        this.inflight = false;
        if (error instanceof ApiError && error.status === 409 && error.body.stale) {
          // The server reloaded the document (it restarted): our versions no longer line up.
          void this.resync();
          return;
        }
        if (error instanceof ApiError && error.status === 409) {
          // Someone else got there first. Their steps usually arrive through the event
          // stream before this response, while the flush they trigger is skipped for the
          // request in flight; if we've already caught up, resend now or nothing will.
          const current = this.view;
          if (current && getVersion(current.state) > body.version) this.flushSteps();
          return;
        }
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          // The server rejected the steps outright; reload from the server copy.
          this.ui.set((ui) => ({ ...ui, sync: "error" }));
          void this.resync();
          return;
        }
        this.ui.set((ui) => ({ ...ui, sync: "error" }));
        this.retryTimer = setTimeout(() => this.flushSteps(), 1500);
      });
  }

  /** Resolve once every local edit has been confirmed by the server. */
  whenSaved(): Promise<void> {
    const view = this.view;
    if (!view || !sendableSteps(view.state)) return Promise.resolve();
    return new Promise((resolve) => this.confirmWaiters.push(resolve));
  }

  private async resync() {
    try {
      const { document } = await api<{ document: Snapshot }>(`/api/documents/${this.id}`);
      this.replaceState(document);
    } catch {
      // The event stream will retry.
    }
  }

  /**
   * Swap in the server's copy of the document, keeping local edits the server
   * hasn't confirmed yet: they're replayed on top when the server's copy is the
   * one they were typed against, and otherwise kept aside for recovery.
   */
  private replaceState(snapshot: Snapshot) {
    const view = this.view;
    if (!view) return;
    if (snapshot.epoch) this.epoch = snapshot.epoch;
    const { from, to } = view.state.selection;
    const local = unconfirmedEdits(view.state);
    const rebased = rebaseLocalEdits(this.createState(snapshot), local);
    let state = rebased.state;
    if (rebased.unmerged) this.ui.set((ui) => ({ ...ui, unmerged: rebased.unmerged }));
    const size = state.doc.content.size;
    try {
      state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, Math.min(from, size), Math.min(to, size))));
    } catch {
      // keep the default selection
    }
    view.updateState(state);
    this.editor.set(state);
    this.applySnapshotUi(snapshot);
    this.updateSync();
  }

  // --- event stream ------------------------------------------------------------------

  private connect() {
    if (this.destroyed || !this.view) return;
    this.source?.close();
    const version = getVersion(this.view.state);
    const source = new EventSource(`/api/documents/${this.id}/events?version=${version}${this.epoch ? `&epoch=${encodeURIComponent(this.epoch)}` : ""}`);
    this.source = source;
    source.onopen = () => this.ui.set((ui) => ({ ...ui, connection: "live" }));
    source.onmessage = (message) => {
      try {
        this.handleEvent(JSON.parse(message.data) as ServerEvent);
      } catch (error) {
        console.error("[inline] bad document event", error);
      }
    };
    source.onerror = () => {
      // Reconnect ourselves so the URL carries the version we've reached.
      source.close();
      if (this.destroyed) return;
      this.ui.set((ui) => ({ ...ui, connection: "reconnecting" }));
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), 1200);
    };
  }

  private handleEvent(event: ServerEvent) {
    const view = this.view;
    if (!view) return;
    syncDomSelection(view);
    switch (event.type) {
      case "snapshot":
        this.replaceState(event.snapshot);
        return;
      case "reset":
        this.replaceState({ ...(this.currentSnapshotUi()), epoch: event.epoch, doc: event.doc, version: event.version, hunks: event.hunks });
        return;
      case "steps": {
        const current = getVersion(view.state);
        const base = event.version - event.steps.length;
        if (event.version <= current) return; // already have these
        if (base !== current) {
          // We missed something; reconnecting replays from our version.
          this.connect();
          return;
        }
        const steps = event.steps.map((json) => Step.fromJSON(schema, json));
        let tr = receiveTransaction(view.state, steps, event.clientIDs, { mapSelectionBackward: true });
        if (event.hunks) {
          tr = setHunks(tr, event.hunks, event.version);
          this.ui.set((ui) => ({ ...ui, hunks: event.hunks! }));
        } else {
          tr = mapHunksThrough(tr, view.state, steps, base, event.version);
        }
        this.dispatch(tr);
        this.updateSync();
        this.flushSteps();
        return;
      }
      case "hunks":
        this.dispatch(setHunks(view.state.tr, event.hunks, event.version));
        this.ui.set((ui) => ({ ...ui, hunks: event.hunks }));
        return;
      case "meta": {
        const previous = this.meta;
        this.ui.set((ui) => ({ ...ui, meta: event.meta }));
        if (previous && JSON.stringify(previous.settings.pageSetup) !== JSON.stringify(event.meta.settings.pageSetup)) relayout(view);
        return;
      }
      case "comments":
        this.ui.set((ui) => ({ ...ui, comments: event.comments }));
        this.syncCommentPlugin(event.comments);
        return;
      case "activity":
        this.applyActivity(event.activity);
        return;
      case "command":
        this.callbacks.onCommand?.(event.command);
        return;
      case "deleted":
        this.ui.set((ui) => ({ ...ui, status: "deleted" }));
        this.source?.close();
        return;
    }
  }

  private currentSnapshotUi(): Snapshot {
    const ui = this.ui.get();
    return { meta: ui.meta!, doc: null, version: 0, comments: ui.comments, hunks: ui.hunks, activity: ui.activity };
  }

  private applyActivity(activity: AgentActivity | null) {
    this.ui.set((ui) => ({ ...ui, activity }));
    const view = this.view;
    if (!view) return;
    view.dispatch(setPresence(view.state.tr, activity ? { status: activity.status, label: activity.label, range: activity.range, version: activity.version } : null));
  }

  private syncCommentPlugin(comments: DocComment[]) {
    const view = this.view;
    if (!view) return;
    view.dispatch(setCommentState(view.state.tr, { open: comments.filter((comment) => !comment.resolved).map((comment) => comment.id) }));
  }

  setActiveComment(id: string | null) {
    if (this.ui.get().activeComment === id) return;
    this.ui.set((ui) => ({ ...ui, activeComment: id }));
    const view = this.view;
    if (view) view.dispatch(setCommentState(view.state.tr, { active: id }));
  }

  // --- selection reporting --------------------------------------------------------------

  private scheduleSelectionReport() {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => this.reportSelection(), 400);
  }

  private reportSelection() {
    const view = this.view;
    if (!view) return;
    // Positions are only meaningful to the server once local edits are confirmed.
    if (sendableSteps(view.state)) {
      this.scheduleSelectionReport();
      return;
    }
    const { from, to } = view.state.selection;
    void post(`/api/documents/${this.id}/selection`, { from, to, version: getVersion(view.state), mode: this.ui.get().mode }).catch(() => undefined);
  }

  // --- modes and preferences ----------------------------------------------------------------

  private storedMode(): EditorMode {
    try {
      const raw = window.localStorage.getItem(`inline-mode:${this.id}`);
      return MODES.includes(raw as EditorMode) ? (raw as EditorMode) : "editing";
    } catch {
      return "editing";
    }
  }

  /** Switch between editing, suggesting and viewing (remembered per document in this browser). */
  async setMode(mode: EditorMode) {
    if (this.ui.get().mode === mode) return;
    this.ui.set((ui) => ({ ...ui, mode }));
    try {
      window.localStorage.setItem(`inline-mode:${this.id}`, mode);
    } catch {
      // Private browsing: the mode lasts for this tab.
    }
    const view = this.view;
    if (view) view.setProps({});
    // Edits typed before the switch keep the mode they were typed in.
    await this.whenSaved();
    if (this.ui.get().mode === mode) this.suggesting = mode === "suggesting";
    this.reportSelection();
  }

  setShowInvisibles(on: boolean) {
    setPreference("showInvisibles", on);
    const view = this.view;
    if (view) view.dispatch(setInvisibles(view.state.tr, on));
  }

  // --- actions ------------------------------------------------------------------------------

  /** Cut or copy the selection through the browser, so rich formatting goes to the clipboard. */
  clipboard(action: "cut" | "copy") {
    const view = this.view;
    if (!view || view.state.selection.empty) return false;
    view.focus();
    return document.execCommand(action);
  }

  /** Paste from the system clipboard; `plain` drops formatting. */
  async paste(plain = false) {
    const view = this.view;
    if (!view) return;
    view.focus();
    try {
      if (!plain && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          if (item.types.includes("text/html")) {
            view.pasteHTML(await (await item.getType("text/html")).text());
            return;
          }
        }
      }
      const text = await navigator.clipboard.readText();
      if (text) view.pasteText(text);
    } catch {
      throw new Error(`Your browser blocked access to the clipboard. Use ${/Mac|iP(hone|[oa]d)/.test(navigator.platform) ? "⌘" : "Ctrl+"}${plain ? "Shift+" : ""}V instead.`);
    }
  }

  run(command: Command) {
    const view = this.view;
    if (!view) return false;
    const result = command(view.state, (tr) => this.dispatch(tr), view);
    view.focus();
    return result;
  }

  async review(action: "accept" | "reject", ids: string[] | "all") {
    await this.whenSaved();
    try {
      await post(`/api/documents/${this.id}/review`, { action, ids });
    } catch (error) {
      console.error("[inline] review failed", error);
    }
  }

  /** Move to the next or previous pending change, optionally only among `only` (ids). */
  gotoChange(direction: 1 | -1, only?: readonly string[]) {
    const view = this.view;
    if (!view) return false;
    const target = gotoHunk(view, direction, only);
    if (!target) return false;
    this.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target.mappedFrom)).scrollIntoView());
    view.focus();
    return true;
  }

  async addComment(body: string) {
    const view = this.view;
    if (!view) return;
    await this.whenSaved();
    const { from, to } = view.state.selection;
    if (from === to) throw new Error("Select some text to comment on.");
    const result = await post<{ comment: DocComment }>(`/api/documents/${this.id}/comments`, { from, to, version: getVersion(view.state), body });
    this.setActiveComment(result.comment.id);
    return result.comment;
  }

  /** Save local edits that couldn't be merged (see `unmerged`) as a new document, and return its id. */
  async recoverUnmerged() {
    const unmerged = this.ui.get().unmerged;
    if (!unmerged) return null;
    const title = `${this.meta?.title ?? "Untitled document"} (recovered edits)`;
    const { document } = await post<{ document: { meta: DocumentMeta } }>("/api/documents", { title, doc: unmerged.doc, settings: this.meta?.settings });
    this.ui.set((ui) => ({ ...ui, unmerged: null }));
    return document.meta.id;
  }

  dismissUnmerged() {
    this.ui.set((ui) => ({ ...ui, unmerged: null }));
  }

  /** Whether the selection includes text locked from AI edits. */
  selectionLocked() {
    const view = this.view;
    if (!view) return false;
    const { from, to } = view.state.selection;
    return from < to && view.state.doc.rangeHasMark(from, to, schema.marks.locked!);
  }

  /** Lock the selection from Claude's edits, or unlock it. */
  async setSelectionLocked(locked: boolean) {
    const view = this.view;
    if (!view) return;
    await this.whenSaved();
    const { from, to } = view.state.selection;
    if (from === to) throw new Error(`Select the text to ${locked ? "lock" : "unlock"}.`);
    await post(`/api/documents/${this.id}/lock`, { from, to, version: getVersion(view.state), locked });
  }

  async updateMeta(patch: { title?: string; settings?: Record<string, unknown> }) {
    const result = await api<{ meta: DocumentMeta }>(`/api/documents/${this.id}`, { method: "PATCH", json: patch });
    this.ui.set((ui) => ({ ...ui, meta: result.meta }));
    if (patch.settings && this.view) relayout(this.view);
    return result.meta;
  }

  /** Text of the current selection, for "Ask Claude about this". */
  selection() {
    const view = this.view;
    if (!view) return null;
    const { from, to } = view.state.selection;
    if (from === to) return null;
    return { documentId: this.id, text: view.state.doc.textBetween(from, to, "\n"), from, to };
  }

  /**
   * Images pasted from other apps arrive as data: URLs inside the document.
   * Upload each one and point the image at the stored file, so documents stay
   * small and exports work. Returns how many were uploaded.
   */
  async uploadInlineImages() {
    const view = this.view;
    if (!view) return 0;
    const sources = new Set<string>();
    view.state.doc.descendants((node) => {
      if (node.type.name === "image" && typeof node.attrs.src === "string" && node.attrs.src.startsWith("data:image/")) sources.add(node.attrs.src);
    });
    let uploaded = 0;
    for (const src of sources) {
      try {
        const blob = dataUrlToBlob(src);
        if (!blob) continue;
        const extension = blob.type.split("/")[1]?.replace("+xml", "") || "png";
        const file = await uploadFile(new File([blob], `pasted-image.${extension}`, { type: blob.type }));
        if (!this.view) return uploaded;
        const tr = this.view.state.tr;
        this.view.state.doc.descendants((node, pos) => {
          if (node.type.name === "image" && node.attrs.src === src) tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: file.url });
        });
        if (tr.docChanged) this.view.dispatch(tr);
        uploaded += 1;
      } catch {
        // Leave it inline; it still shows and saves.
      }
    }
    return uploaded;
  }

  scrollTo(from: number, to: number) {
    const view = this.view;
    if (!view) return;
    const size = view.state.doc.content.size;
    const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, Math.min(from, size), Math.min(to, size))).scrollIntoView();
    this.dispatch(tr);
  }
}


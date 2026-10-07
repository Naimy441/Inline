"use client";

import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { DocumentSession } from "@/lib/client/documentSession";
import { PageCanvas } from "@/components/workspace/PageCanvas";

/**
 * First-page thumbnails for documents nobody has opened yet (imports,
 * documents Claude made). Each is laid out off screen exactly as the editor
 * would show it, then drawn and saved, one document at a time.
 */

function OffscreenPages({ session }: { session: DocumentSession }) {
  const ui = useSyncExternalStore(session.ui.subscribe, session.ui.get, session.ui.get);
  return <PageCanvas session={session} meta={ui.meta} pages={ui.pages} zoom={1} printing={false} flow={false} />;
}

const TIMEOUT_MS = 20_000;
const START_DELAY_MS = 1200;

/**
 * Draw and save one document's thumbnail. Resolves to when it was saved, or
 * null if it couldn't be drawn. Aborting removes the off-screen copy at once
 * (leaving the home page mustn't leave a stray editor behind).
 */
export async function captureThumbnail(id: string, signal?: AbortSignal): Promise<number | null> {
  if (signal?.aborted) return null;
  const host = document.createElement("div");
  host.className = "offscreen-pages";
  host.setAttribute("aria-hidden", "true");
  document.body.append(host);
  const session = new DocumentSession(id, { offline: true });
  const root = createRoot(host);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    root.unmount();
    host.remove();
  };
  const aborted = new Promise<null>((resolve) => signal?.addEventListener("abort", () => resolve(null), { once: true }));
  signal?.addEventListener("abort", cleanup, { once: true });
  try {
    root.render(<OffscreenPages session={session} />);
    const started = Date.now();
    const loaded = new Promise<void>((resolve, reject) => {
      const check = () => {
        if (signal?.aborted) return reject(new Error("Stopped."));
        const { status, error } = session.ui.get();
        if (status === "ready") return resolve();
        if (status === "error" || status === "deleted") return reject(new Error(error ?? "The document couldn't be loaded."));
        if (Date.now() - started > TIMEOUT_MS) return reject(new Error("Timed out."));
        setTimeout(check, 30);
      };
      check();
    });
    await loaded;
    return await Promise.race([session.captureThumbnail(), aborted, new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS))]);
  } catch {
    return null;
  } finally {
    cleanup();
  }
}

function whenVisible() {
  if (document.visibilityState === "visible") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onChange = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    document.addEventListener("visibilitychange", onChange);
  });
}

export type ThumbnailProgress = { done: number; total: number };

/**
 * A queue of documents waiting for thumbnails, worked through in the
 * background. Drawing needs animation frames, so it waits while the tab is
 * hidden.
 */
export class ThumbnailQueue {
  private pending: string[] = [];
  private queued = new Set<string>();
  private running = false;
  private stopped = false;
  private readonly abort = new AbortController();
  private progress: ThumbnailProgress = { done: 0, total: 0 };

  constructor(
    private readonly onSaved: (id: string, thumbnailAt: number) => void,
    private readonly onProgress: (progress: ThumbnailProgress | null) => void,
  ) {}

  add(ids: string[]) {
    const fresh = ids.filter((id) => !this.queued.has(id));
    if (!fresh.length || this.stopped) return;
    for (const id of fresh) this.queued.add(id);
    this.pending.push(...fresh);
    this.progress = { ...this.progress, total: this.progress.total + fresh.length };
    this.onProgress(this.progress);
    void this.run();
  }

  stop() {
    this.stopped = true;
    this.pending = [];
    this.abort.abort();
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      // Let the page settle (and the user act) before drawing in the background.
      await new Promise((resolve) => setTimeout(resolve, START_DELAY_MS));
      while (this.pending.length && !this.stopped) {
        await whenVisible();
        const id = this.pending.shift()!;
        const at = await captureThumbnail(id, this.abort.signal);
        if (this.stopped) return;
        if (at) this.onSaved(id, at);
        this.progress = { ...this.progress, done: this.progress.done + 1 };
        this.onProgress(this.progress);
      }
    } finally {
      this.running = false;
      if (!this.pending.length) {
        this.progress = { done: 0, total: 0 };
        if (!this.stopped) this.onProgress(null);
      }
    }
  }
}

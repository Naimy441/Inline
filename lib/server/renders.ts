import { randomUUID } from "node:crypto";
import type { LiveDocument } from "@/lib/server/hub";

/**
 * Pictures of the document's pages as the user's editor lays them out, for
 * Claude to compare with the original PDF pages (lib/agent/pdfTools.ts).
 * Only a browser can lay pages out, so the server asks the open editor
 * (a "render_pages" command) and waits for it to post the pictures back to
 * /api/documents/[id]/render.
 */

/** A line of text on a rendered page: its left edge and baseline in points from the top left. */
export type RenderedLine = { x: number; y: number; size: number; text: string };

/** A top-level block on a rendered page: its id, and its top and bottom in points from the page's top. */
export type RenderedBlock = { id: string; top: number; bottom: number; joined?: boolean; /** For a block sharing a box with the one before: the space between them, in points. */ inside?: number };

export type RenderedPage = { page: number; png: Uint8Array; lines?: RenderedLine[]; blocks?: RenderedBlock[] };

type Waiting = { documentId: string; resolve: (pages: RenderedPage[]) => void; timer: ReturnType<typeof setTimeout> };

const waiting = new Map<string, Waiting>();

export class RenderUnavailableError extends Error {}

/** Ask the open editor for pictures of these pages (0-based), at `scale` pixels per point. */
export function requestPageRenders(doc: LiveDocument, pages: number[], options: { scale?: number; timeoutMs?: number } = {}): Promise<RenderedPage[]> {
  const requestId = randomUUID();
  return new Promise<RenderedPage[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(requestId);
      reject(new RenderUnavailableError("The editor didn't send the page pictures in time. The document needs to be open in Inline."));
    }, options.timeoutMs ?? 45_000);
    timer.unref?.();
    waiting.set(requestId, { documentId: doc.id, resolve, timer });
    const viewers = doc.sendCommand({ kind: "render_pages", requestId, pages, scale: options.scale ?? 2 });
    if (!viewers) {
      clearTimeout(timer);
      waiting.delete(requestId);
      reject(new RenderUnavailableError("The document isn't open in an editor, so its pages can't be pictured. Ask the user to open it in Inline."));
    }
  });
}

/** The editor's answer. Returns false for a request that isn't waiting (answered by another tab, or timed out). */
export function deliverPageRenders(documentId: string, requestId: string, pages: RenderedPage[]) {
  const entry = waiting.get(requestId);
  if (!entry || entry.documentId !== documentId) return false;
  waiting.delete(requestId);
  clearTimeout(entry.timer);
  entry.resolve(pages);
  return true;
}

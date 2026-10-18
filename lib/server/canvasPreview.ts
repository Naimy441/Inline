import { randomBytes } from "node:crypto";
import type { DocumentSnapshot } from "@/lib/server/hub";

const TTL_MS = 60_000;
const previews = new Map<string, { documentId: string; snapshot: DocumentSnapshot; expires: number }>();

/** A canvas patch measured in the headless renderer without writing the document. */
export function putCanvasPreview(documentId: string, snapshot: DocumentSnapshot) {
  const now = Date.now();
  for (const [token, entry] of previews) if (entry.expires <= now) previews.delete(token);
  const token = randomBytes(16).toString("hex");
  previews.set(token, { documentId, snapshot, expires: now + TTL_MS });
  return token;
}

export function readCanvasPreview(token: string, documentId: string): DocumentSnapshot | null {
  const entry = previews.get(token);
  if (!entry || entry.expires <= Date.now() || entry.documentId !== documentId) return null;
  return entry.snapshot;
}

export function dropCanvasPreview(token: string) {
  previews.delete(token);
}

import { randomUUID } from "node:crypto";
import type { FitKind, FitMeasurement } from "@/lib/doc/pageFit";
import type { LiveDocument } from "@/lib/server/hub";

/**
 * A measurement of the open editor's pages, for fit_page_to_half and
 * fit_pages_onto_one. Only a browser lays the pages out, so the server asks
 * the open editor (a "measure_fit" command) and waits for it to post the
 * measurement back to /api/documents/[id]/fit.
 */

type Waiting = {
  documentId: string;
  resolve: (measurement: FitMeasurement) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const waiting = new Map<string, Waiting>();

export class FitUnavailableError extends Error {}

/** Ask the open editor to measure the pages a fit will squeeze. */
export function requestFitMeasurement(doc: LiveDocument, kind: FitKind, timeoutMs = 10_000): Promise<FitMeasurement> {
  const requestId = randomUUID();
  return new Promise<FitMeasurement>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(requestId);
      reject(new FitUnavailableError("The editor didn't send the page measurement in time. The document needs to be open in Inline."));
    }, timeoutMs);
    timer.unref?.();
    waiting.set(requestId, { documentId: doc.id, resolve, reject, timer });
    const viewers = doc.sendCommand({ kind: "measure_fit", requestId, fit: kind });
    if (!viewers) {
      clearTimeout(timer);
      waiting.delete(requestId);
      reject(new FitUnavailableError("The document isn't open in an editor, so its pages can't be measured. Ask the user to open it in Inline."));
    }
  });
}

/** The editor's answer. Returns false for a request that isn't waiting. */
export function deliverFitMeasurement(documentId: string, requestId: string, answer: { error?: string; measurement?: FitMeasurement }) {
  const entry = waiting.get(requestId);
  if (!entry || entry.documentId !== documentId) return false;
  waiting.delete(requestId);
  clearTimeout(entry.timer);
  if (answer.measurement) entry.resolve(answer.measurement);
  else entry.reject(new FitUnavailableError(answer.error || "The editor didn't send a page measurement."));
  return true;
}

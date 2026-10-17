/**
 * What a turn did to a document, kept on the reply so Copy chat logs can replay
 * a bad edit. Short edits keep the markdown from before and after. A long
 * document keeps a diff of what changed, not a second copy of the whole text.
 */

import { diffParagraphs } from "@/lib/doc/textDiff";
import type { DocumentPendingHunk, DocumentTurnLog } from "@/lib/agent/types";

/** Before and after together, above which the log keeps a diff instead of both texts. */
export const DOCUMENT_SNAPSHOT_LIMIT = 24_000;
const DIFF_LIMIT = 24_000;
const HUNK_TEXT = 400;
const MAX_HUNKS = 30;

function clip(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A readable diff that skips paragraphs the turn left alone. */
export function editDiff(before: string, after: string) {
  const paragraphs = diffParagraphs(before, after);
  const chunks: string[] = [];
  let skipped = false;
  for (const paragraph of paragraphs) {
    if (paragraph.kind === "same") {
      skipped = true;
      continue;
    }
    if (skipped && chunks.length) chunks.push("…");
    skipped = false;
    if (paragraph.kind === "delete") {
      chunks.push(`- ${paragraph.parts.map((part) => part.text).join("")}`);
      continue;
    }
    if (paragraph.kind === "insert") {
      chunks.push(`+ ${paragraph.parts.map((part) => part.text).join("")}`);
      continue;
    }
    const line = paragraph.parts
      .map((part) => (part.kind === "same" ? part.text : part.kind === "delete" ? `[-${part.text}-]` : `{+${part.text}+}`))
      .join("");
    chunks.push(line);
  }
  let text = chunks.join("\n").trim();
  if (!text) return "(no textual difference)";
  if (text.length > DIFF_LIMIT) text = `${text.slice(0, DIFF_LIMIT)}\n…(diff truncated)`;
  return text;
}

function pendingHunks(pending: readonly DocumentPendingHunk[]): DocumentPendingHunk[] | undefined {
  if (!pending.length) return undefined;
  return pending.slice(0, MAX_HUNKS).map((hunk) => ({
    id: hunk.id,
    deleted: clip(hunk.deleted, HUNK_TEXT),
    inserted: clip(hunk.inserted, HUNK_TEXT),
  }));
}

/**
 * Build the log entry for one document. `before` is null when this turn did
 * not change it, or when an edit happened but the earlier text could not be read.
 * Pass `before: ""` when the document was created during the turn.
 */
export function documentTurnLog(input: {
  documentId: string;
  title: string;
  before: string | null;
  after: string;
  changed: boolean;
  pending: readonly DocumentPendingHunk[];
}): DocumentTurnLog {
  const log: DocumentTurnLog = { documentId: input.documentId, title: input.title };
  const pending = pendingHunks(input.pending);
  if (pending) log.pending = pending;
  const same = input.before !== null && input.before === input.after;
  if (!input.changed || same) return log;
  if (input.before === null) {
    if (input.after.length <= DOCUMENT_SNAPSHOT_LIMIT) log.after = input.after;
    else log.diff = "(the text from before this turn could not be read, and the document is too large to include)";
    return log;
  }
  if (input.before.length + input.after.length <= DOCUMENT_SNAPSHOT_LIMIT) {
    log.before = input.before;
    log.after = input.after;
    return log;
  }
  log.diff = editDiff(input.before, input.after);
  return log;
}

import { labelDocument, locateInText } from "@/lib/agent/documentMap";
import type { AgentEditDraft, AgentLockedRange, AgentTask, DocumentPageSlice } from "@/lib/agent/types";
import { tidyDocumentText } from "@/lib/writing/documentQuality";

export const SHORT_DOC_CHARS = 4_000;
export const READ_DOCUMENT_CHARS = 12_000;

export type DocumentSessionSeed = {
  title: string;
  text: string;
  pages?: DocumentPageSlice[];
  locked?: AgentLockedRange[];
};

export type SearchHit = {
  paragraphId: string;
  page: number;
  snippet: string;
};

export type OutlineItem = {
  paragraphId: string;
  page: number;
  text: string;
  heading: boolean;
};

export type WriteResult = {
  ok: true;
  edit: AgentEditDraft;
  chars: number;
  pageCount: number;
} | {
  ok: false;
  error: string;
};

export class DocumentSession {
  title: string;
  text: string;
  pages: DocumentPageSlice[];
  locked: AgentLockedRange[];
  edits: AgentEditDraft[] = [];
  tasks: AgentTask[] = [];
  chatTitle?: string;

  constructor(seed: DocumentSessionSeed) {
    this.title = seed.title;
    this.text = seed.text.replace(/\u00a0/g, " ");
    this.locked = seed.locked ?? [];
    this.pages = normalizePages(this.text, seed.pages);
  }

  seed(next: DocumentSessionSeed) {
    this.title = next.title || this.title;
    this.text = next.text.replace(/\u00a0/g, " ");
    this.locked = next.locked ?? this.locked;
    this.pages = normalizePages(this.text, next.pages);
    this.edits = [];
  }

  paragraphs() {
    return labelDocument(this.text).paragraphs;
  }

  pageCount() {
    return Math.max(1, this.pages.length);
  }

  pageOfOffset(offset: number) {
    const page = this.pages.find((item) => offset >= item.start && offset < item.end);
    return page?.number ?? this.pages[this.pages.length - 1]?.number ?? 1;
  }

  outline(): OutlineItem[] {
    return this.paragraphs().map((paragraph) => {
      const at = this.text.indexOf(paragraph.text);
      return {
        paragraphId: paragraph.id,
        page: at >= 0 ? this.pageOfOffset(at) : 1,
        text: paragraph.text,
        heading: isHeading(paragraph.text),
      };
    });
  }

  search(query: string, limit = 8): SearchHit[] {
    const needle = query.trim();
    if (!needle) return [];
    const lower = needle.toLowerCase();
    const hits: SearchHit[] = [];
    for (const paragraph of this.paragraphs()) {
      const at = paragraph.text.toLowerCase().indexOf(lower);
      if (at < 0) continue;
      const start = this.text.indexOf(paragraph.text);
      hits.push({
        paragraphId: paragraph.id,
        page: start >= 0 ? this.pageOfOffset(start) : 1,
        snippet: clipAround(paragraph.text, at, needle.length),
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  read(args: {
    page?: number;
    pages?: number[];
    paragraphId?: string;
    from?: string;
    to?: string;
    start?: number;
    end?: number;
    query?: string;
    scope?: "document";
  }) {
    const pageCount = this.pageCount();
    const chars = this.text.length;

    if (args.query?.trim()) {
      return { query: args.query, hits: this.search(args.query), pageCount, chars };
    }

    if (args.scope === "document") {
      if (this.text.length <= READ_DOCUMENT_CHARS) {
        return { scope: "document", text: this.text, truncated: false, pageCount, chars, paragraphs: this.paragraphs() };
      }
      const startPage = args.page && args.page > 1 ? args.page : 1;
      const slice = this.pageSlice(startPage);
      return {
        scope: "document",
        text: slice?.text ?? "",
        page: startPage,
        truncated: true,
        pageCount,
        nextPage: startPage < pageCount ? startPage + 1 : undefined,
        charsRemaining: Math.max(0, chars - (slice?.end ?? 0)),
        outline: this.outline()
          .filter((item) => item.heading)
          .slice(0, 20)
          .map((item) => `${item.paragraphId} p${item.page}: ${item.text}`),
        chars,
      };
    }

    if (args.pages?.length) {
      const items = args.pages.map((number) => this.pageSlice(number)).filter(Boolean);
      return {
        pages: items.map((slice) => slice && ({
          ...slice,
          paragraphs: this.paragraphsInRange(slice.start, slice.end),
        })),
        pageCount,
        chars,
      };
    }

    if (args.page) {
      const slice = this.pageSlice(args.page);
      return {
        page: args.page,
        text: slice?.text ?? "",
        paragraphs: slice ? this.paragraphsInRange(slice.start, slice.end) : [],
        pageCount,
        chars: slice?.text.length ?? 0,
        missing: !slice,
      };
    }

    if (args.start != null || args.end != null) {
      const start = Math.max(0, args.start ?? 0);
      const end = Math.min(this.text.length, args.end ?? this.text.length);
      return { start, end, text: this.text.slice(start, end), pageCount, chars };
    }

    if (args.paragraphId || args.from || args.to) {
      const paragraphs = this.paragraphs();
      const fromId = args.from || args.paragraphId;
      const toId = args.to || args.paragraphId;
      const from = paragraphs.findIndex((item) => item.id === fromId);
      const to = paragraphs.findIndex((item) => item.id === toId);
      if (from < 0 || to < 0) return { error: "Unknown paragraph id.", pageCount, chars };
      const slice = paragraphs.slice(Math.min(from, to), Math.max(from, to) + 1);
      return {
        paragraphs: slice,
        text: slice.map((item) => item.text).join("\n\n"),
        pageCount,
        chars,
      };
    }

    const first = this.pageSlice(1);
    return {
      page: 1,
      text: first?.text ?? this.text,
      paragraphs: this.paragraphsInRange(first?.start ?? 0, first?.end ?? this.text.length),
      pageCount,
      chars,
      hint: pageCount > 1 ? "Pass page, pages, a paragraph range, or scope: \"document\"." : undefined,
    };
  }

  replaceText(find: string, replace: string, occurrence = 0, reason?: string): WriteResult {
    return this.commitWrite({ find, replace, occurrence, reason, operation: replace === "" ? "delete" : "replace" });
  }

  insertText(text: string, afterFind?: string, paragraphId?: string, reason?: string): WriteResult {
    if (!text) return { ok: false, error: "Nothing to insert." };
    if (!this.text.trim() && !afterFind && !paragraphId) {
      return this.commitWrite({ find: "", replace: text, operation: "insert", reason });
    }
    const anchor = paragraphId
      ? this.paragraphs().find((item) => item.id === paragraphId)?.text
      : afterFind;
    if (!anchor) {
      if (!afterFind && !paragraphId) {
        const last = this.paragraphs().at(-1)?.text ?? this.text;
        return this.commitWrite({
          find: last,
          replace: last ? `${last}\n\n${text}` : text,
          operation: "insert",
          reason,
        });
      }
      return { ok: false, error: paragraphId ? `Unknown paragraph ${paragraphId}.` : "Anchor text was not found." };
    }
    return this.commitWrite({
      find: anchor,
      replace: `${anchor}\n\n${text}`,
      operation: "insert",
      reason,
    });
  }

  deleteText(find: string, occurrence = 0, reason?: string): WriteResult {
    if (!find) return { ok: false, error: "Find text is required." };
    return this.commitWrite({ find, replace: "", occurrence, operation: "delete", reason });
  }

  private paragraphsInRange(start: number, end: number) {
    const items: { id: string; text: string }[] = [];
    let from = 0;
    for (const paragraph of this.paragraphs()) {
      const at = this.text.indexOf(paragraph.text, from);
      if (at < 0) continue;
      from = at + Math.max(1, paragraph.text.length);
      if (at >= start && at < end) items.push({ id: paragraph.id, text: paragraph.text });
    }
    return items;
  }

  private pageSlice(number: number) {
    return this.pages.find((page) => page.number === number);
  }

  private commitWrite(draft: AgentEditDraft): WriteResult {
    if (touchesLock(this.text, this.locked, draft.find)) {
      return { ok: false, error: "That passage is locked." };
    }

    if (draft.operation === "insert" && draft.find === "") {
      const start = this.text.length;
      this.splice(start, start, draft.replace);
      this.edits.push(draft);
      return { ok: true, edit: draft, chars: this.text.length, pageCount: this.pageCount() };
    }

    const located = locateOccurrence(this.text, draft.find, draft.occurrence ?? 0);
    if (!located) return { ok: false, error: "Find text was not in the document." };

    const original = this.text;
    const span = expandWrite(original, located.start, located.end, draft.replace);
    const find = original.slice(span.start, span.end);
    const occurrence = occurrenceOf(original, find, span.start);
    const edit: AgentEditDraft = {
      ...draft,
      find,
      replace: span.replacement,
      occurrence,
    };
    this.splice(span.start, span.end, span.replacement);
    this.edits.push(edit);
    return { ok: true, edit, chars: this.text.length, pageCount: this.pageCount() };
  }

  private splice(start: number, end: number, replacement: string) {
    const next = tidyDocumentText(`${this.text.slice(0, start)}${replacement}${this.text.slice(end)}`);
    const delta = next.length - this.text.length;
    this.text = next;
    this.pages = this.pages.map((page) => {
      if (page.end <= start) {
        const endAt = Math.min(page.end, this.text.length);
        return { ...page, end: endAt, text: this.text.slice(page.start, endAt) };
      }
      if (page.start >= end) {
        const nextStart = Math.max(0, Math.min(this.text.length, page.start + delta));
        const nextEnd = Math.max(nextStart, Math.min(this.text.length, page.end + delta));
        return { ...page, start: nextStart, end: nextEnd, text: this.text.slice(nextStart, nextEnd) };
      }
      const nextEnd = Math.max(page.start, Math.min(this.text.length, page.end + delta));
      return { ...page, end: nextEnd, text: this.text.slice(page.start, nextEnd) };
    });
    this.pages = dropEmptyPages(this.pages, this.text);
  }
}

function dropEmptyPages(pages: DocumentPageSlice[], text: string): DocumentPageSlice[] {
  const kept = pages.filter((page) => text.slice(page.start, page.end).trim().length > 0);
  if (!kept.length) {
    return [{ number: 1, start: 0, end: text.length, text }];
  }
  return kept.map((page, index) => {
    const start = Math.max(0, Math.min(page.start, text.length));
    const end = Math.max(start, Math.min(page.end, text.length));
    return { ...page, number: index + 1, start, end, text: text.slice(start, end) };
  });
}

function expandWrite(text: string, start: number, end: number, replacement: string) {
  if (replacement) return { start, end, replacement };
  let from = start;
  let to = end;
  while (from > 0 && /[ \t]/.test(text[from - 1]!)) from -= 1;
  while (to < text.length && /[ \t]/.test(text[to]!)) to += 1;
  const leftChar = text[from - 1] ?? "";
  const rightChar = text[to] ?? "";
  let next = leftChar && rightChar && !/\s/.test(leftChar) && !/\s/.test(rightChar) ? " " : "";
  const raw = `${text.slice(0, from)}${next}${text.slice(to)}`;
  if (/\n{3,}/.test(raw)) {
    while (from > 0 && text[from - 1] === "\n") from -= 1;
    while (to < text.length && text[to] === "\n") to += 1;
    next = text.slice(0, from).trim() && text.slice(to).trim() ? "\n\n" : "";
  }
  return { start: from, end: to, replacement: next };
}

function normalizePages(text: string, pages?: DocumentPageSlice[]): DocumentPageSlice[] {
  if (!pages?.length) {
    return [{ number: 1, start: 0, end: text.length, text }];
  }
  return pages.map((page, index) => {
    const start = Math.max(0, Math.min(page.start, text.length));
    const end = Math.max(start, Math.min(page.end, text.length));
    return {
      number: page.number || index + 1,
      start,
      end,
      text: text.slice(start, end),
    };
  });
}

function isHeading(text: string) {
  return text.length < 90 && /^(#{1,3}\s|[A-Z0-9].{0,70})$/.test(text) && !/[.!?]$/.test(text);
}

function clipAround(text: string, at: number, length: number) {
  const start = Math.max(0, at - 80);
  const end = Math.min(text.length, at + length + 80);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function locateOccurrence(document: string, find: string, occurrence: number) {
  const needle = find.replace(/\u00a0/g, " ");
  if (!needle) return null;
  let from = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const hit = document.indexOf(needle, from);
    if (hit >= 0) {
      if (index === occurrence) return { start: hit, end: hit + needle.length };
      from = hit + Math.max(1, needle.length);
      continue;
    }
    break;
  }
  return locateInText(document, needle);
}

function occurrenceOf(document: string, find: string, start: number) {
  let count = 0;
  let from = 0;
  while (find) {
    const hit = document.indexOf(find, from);
    if (hit < 0 || hit >= start) return count;
    count += 1;
    from = hit + Math.max(1, find.length);
  }
  return count;
}

function touchesLock(document: string, locked: AgentLockedRange[], find: string) {
  if (!find.trim()) return false;
  return locked.some((range) => {
    const lock = range.text.replace(/\u00a0/g, " ");
    return lock.includes(find) || find.includes(lock);
  }) || locked.some((range) => {
    const lock = locateInText(document, range.text);
    const target = locateInText(document, find);
    if (!lock || !target) return false;
    return target.start < lock.end && target.end > lock.start;
  });
}

import { DEFAULT_PAGE_LAYOUT, PAPER_SIZES, type PageLayout, type PaperSize } from "@/lib/pagination";

export type StoredComment = {
  id: string;
  quote: string;
  body: string;
};

export type HeaderAlign = "left" | "center" | "right" | "justify";
export type PageNumberLocation = "header" | "footer";

export type StoredDocument = {
  id: string;
  version: 2;
  title: string;
  html: string;
  headerText: string;
  footerText: string;
  firstHeaderText: string;
  firstFooterText: string;
  showHeader: boolean;
  showFooter: boolean;
  showPageNumbers: boolean;
  differentFirstPage: boolean;
  pageNumberLocation: PageNumberLocation;
  headerAlign: HeaderAlign;
  footerAlign: HeaderAlign;
  fontFamily: string;
  fontSize: string;
  columns: number;
  lineSpacing: string;
  pageLayout?: PageLayout;
  comments: StoredComment[];
  lastOpenedAt: number;
  updatedAt: number;
  deletedAt?: number | null;
};

export type DocumentDraft = Omit<StoredDocument, "id" | "version" | "updatedAt" | "lastOpenedAt">;

export const DOCUMENTS_STORAGE_KEY = "inline-documents-v2";
export const DOCUMENT_STORAGE_KEY = "inline-document-v1";

export function listDocuments(options: { includeTrashed?: boolean } = {}): StoredDocument[] {
  const documents = readDocuments();
  return (options.includeTrashed ? documents : documents.filter((document) => !document.deletedAt))
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export function loadDocument(id?: string): StoredDocument | null {
  if (typeof window === "undefined") return null;
  const documents = listDocuments({ includeTrashed: true });
  const document = id ? documents.find((item) => item.id === id && !item.deletedAt) : documents.find((item) => !item.deletedAt);
  if (!document) return null;
  touchDocument(document.id);
  return document;
}

function parsePageNumberLocation(value: unknown): PageNumberLocation {
  return value === "header" ? "header" : "footer";
}

function parseHeaderAlign(value: unknown): HeaderAlign {
  return value === "left" || value === "right" || value === "justify" ? value : "center";
}

function parseFontFamily(value: unknown) {
  return typeof value === "string" && value.trim() ? value : "Arial, Helvetica, sans-serif";
}

function parseFontSize(value: unknown) {
  return typeof value === "string" && value.trim() ? value : "11pt";
}

function parsePageLayout(value: unknown): PageLayout {
  if (!value || typeof value !== "object") return DEFAULT_PAGE_LAYOUT;
  const candidate = value as Partial<PageLayout>;
  const paperSize: PaperSize = candidate.paperSize && candidate.paperSize in PAPER_SIZES ? candidate.paperSize : "letter";
  const paper = PAPER_SIZES[paperSize];
  const number = (input: unknown, fallback: number) =>
    typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : fallback;
  const layout = {
    paperSize,
    width: paper.width,
    height: paper.height,
    marginTop: number(candidate.marginTop, DEFAULT_PAGE_LAYOUT.marginTop),
    marginRight: number(candidate.marginRight, DEFAULT_PAGE_LAYOUT.marginRight),
    marginBottom: number(candidate.marginBottom, DEFAULT_PAGE_LAYOUT.marginBottom),
    marginLeft: number(candidate.marginLeft, DEFAULT_PAGE_LAYOUT.marginLeft),
  } satisfies PageLayout;
  return layout;
}

export function createDocument(input: Partial<DocumentDraft> = {}): StoredDocument {
  const now = Date.now();
  const document: StoredDocument = {
    id: createDocumentId(),
    version: 2,
    title: cleanTitle(input.title),
    html: typeof input.html === "string" ? input.html : "<div><br></div>",
    headerText: typeof input.headerText === "string" ? input.headerText : "",
    footerText: typeof input.footerText === "string" ? input.footerText : "",
    firstHeaderText: typeof input.firstHeaderText === "string" ? input.firstHeaderText : "",
    firstFooterText: typeof input.firstFooterText === "string" ? input.firstFooterText : "",
    showHeader: Boolean(input.showHeader),
    showFooter: Boolean(input.showFooter),
    showPageNumbers: Boolean(input.showPageNumbers),
    differentFirstPage: Boolean(input.differentFirstPage),
    pageNumberLocation: parsePageNumberLocation(input.pageNumberLocation),
    headerAlign: parseHeaderAlign(input.headerAlign),
    footerAlign: parseHeaderAlign(input.footerAlign),
    fontFamily: parseFontFamily(input.fontFamily),
    fontSize: parseFontSize(input.fontSize),
    columns: input.columns === 2 || input.columns === 3 ? input.columns : 1,
    lineSpacing: typeof input.lineSpacing === "string" && input.lineSpacing ? input.lineSpacing : "1.15",
    pageLayout: input.pageLayout ?? DEFAULT_PAGE_LAYOUT,
    comments: Array.isArray(input.comments) ? input.comments.filter(isComment) : [],
    lastOpenedAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const documents = listDocuments({ includeTrashed: true });
  writeDocuments([document, ...documents]);
  return document;
}

export function saveDocument(doc: DocumentDraft, id?: string) {
  if (typeof window === "undefined") return;
  const documents = listDocuments({ includeTrashed: true });
  const targetId = id ?? documents.find((document) => !document.deletedAt)?.id ?? createDocumentId();
  const current = documents.find((document) => document.id === targetId);
  const now = Date.now();
  const payload: StoredDocument = {
    id: targetId,
    version: 2,
    title: cleanTitle(doc.title),
    html: doc.html,
    headerText: doc.headerText,
    footerText: doc.footerText,
    firstHeaderText: doc.firstHeaderText,
    firstFooterText: doc.firstFooterText,
    showHeader: doc.showHeader,
    showFooter: doc.showFooter,
    showPageNumbers: doc.showPageNumbers,
    differentFirstPage: doc.differentFirstPage,
    pageNumberLocation: parsePageNumberLocation(doc.pageNumberLocation),
    headerAlign: parseHeaderAlign(doc.headerAlign),
    footerAlign: parseHeaderAlign(doc.footerAlign),
    fontFamily: parseFontFamily(doc.fontFamily),
    fontSize: parseFontSize(doc.fontSize),
    columns: doc.columns,
    lineSpacing: doc.lineSpacing,
    pageLayout: doc.pageLayout ?? DEFAULT_PAGE_LAYOUT,
    comments: doc.comments,
    lastOpenedAt: current?.lastOpenedAt ?? now,
    updatedAt: now,
    deletedAt: current?.deletedAt ?? null,
  };
  writeDocuments([payload, ...documents.filter((document) => document.id !== targetId)]);
}

export function touchDocument(id: string) {
  if (typeof window === "undefined") return;
  const documents = listDocuments({ includeTrashed: true });
  const now = Date.now();
  let changed = false;
  const next = documents.map((document) => {
    if (document.id !== id) return document;
    changed = true;
    return { ...document, lastOpenedAt: now };
  });
  if (changed) writeDocuments(next);
}

export function renameDocument(id: string, title: string) {
  if (typeof window === "undefined") return;
  const documents = listDocuments({ includeTrashed: true });
  writeDocuments(documents.map((document) => (document.id === id ? { ...document, title: cleanTitle(title), updatedAt: Date.now() } : document)));
}

export function trashDocument(id: string) {
  if (typeof window === "undefined") return;
  const documents = listDocuments({ includeTrashed: true });
  writeDocuments(documents.map((document) => (document.id === id ? { ...document, deletedAt: Date.now(), updatedAt: Date.now() } : document)));
}

export function restoreDocument(id: string) {
  if (typeof window === "undefined") return;
  const documents = listDocuments({ includeTrashed: true });
  writeDocuments(
    documents.map((document) => (document.id === id ? { ...document, deletedAt: null, updatedAt: Date.now() } : document)),
  );
}

export function purgeDocument(id: string) {
  if (typeof window === "undefined") return;
  const documents = listDocuments({ includeTrashed: true });
  writeDocuments(documents.filter((document) => document.id !== id));
}

export function duplicateDocument(id: string): StoredDocument | null {
  const source = listDocuments({ includeTrashed: true }).find((document) => document.id === id && !document.deletedAt);
  if (!source) return null;
  return createDocument({
    title: `${source.title} copy`,
    html: source.html,
    headerText: source.headerText,
    footerText: source.footerText,
    firstHeaderText: source.firstHeaderText,
    firstFooterText: source.firstFooterText,
    showHeader: source.showHeader,
    showFooter: source.showFooter,
    showPageNumbers: source.showPageNumbers,
    differentFirstPage: source.differentFirstPage,
    pageNumberLocation: source.pageNumberLocation,
    headerAlign: source.headerAlign,
    footerAlign: source.footerAlign,
    fontFamily: source.fontFamily,
    fontSize: source.fontSize,
    columns: source.columns,
    lineSpacing: source.lineSpacing,
    pageLayout: source.pageLayout,
    comments: source.comments,
  });
}

function readDocuments(): StoredDocument[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(DOCUMENTS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((item, index) => normalizeDocument(item, `doc-${index + 1}`)).filter(Boolean) as StoredDocument[];
    }
    const legacyRaw = window.localStorage.getItem(DOCUMENT_STORAGE_KEY);
    if (!legacyRaw) return [];
    const legacy = normalizeDocument(JSON.parse(legacyRaw), "doc-legacy");
    if (!legacy) return [];
    writeDocuments([legacy]);
    return [legacy];
  } catch {
    return [];
  }
}

function writeDocuments(documents: StoredDocument[]) {
  try {
    window.localStorage.setItem(DOCUMENTS_STORAGE_KEY, JSON.stringify(documents));
  } catch {
    // Quota or private-mode failures should not break editing.
  }
}

function normalizeDocument(value: unknown, fallbackId: string): StoredDocument | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<StoredDocument>;
  if (typeof parsed.html !== "string") return null;
  const now = Date.now();
  return {
    id: typeof parsed.id === "string" && parsed.id ? parsed.id : fallbackId,
    version: 2,
    title: cleanTitle(parsed.title),
    html: parsed.html,
    headerText: typeof parsed.headerText === "string" ? parsed.headerText : "",
    footerText: typeof parsed.footerText === "string" ? parsed.footerText : "",
    firstHeaderText: typeof parsed.firstHeaderText === "string" ? parsed.firstHeaderText : "",
    firstFooterText: typeof parsed.firstFooterText === "string" ? parsed.firstFooterText : "",
    showHeader: Boolean(parsed.showHeader),
    showFooter: Boolean(parsed.showFooter),
    showPageNumbers: Boolean(parsed.showPageNumbers),
    differentFirstPage: Boolean(parsed.differentFirstPage),
    pageNumberLocation: parsePageNumberLocation(parsed.pageNumberLocation),
    headerAlign: parseHeaderAlign(parsed.headerAlign),
    footerAlign: parseHeaderAlign(parsed.footerAlign),
    fontFamily: parseFontFamily(parsed.fontFamily),
    fontSize: parseFontSize(parsed.fontSize),
    columns: parsed.columns === 2 || parsed.columns === 3 ? parsed.columns : 1,
    lineSpacing: typeof parsed.lineSpacing === "string" && parsed.lineSpacing ? parsed.lineSpacing : "1.15",
    pageLayout: parsePageLayout(parsed.pageLayout),
    comments: Array.isArray(parsed.comments) ? parsed.comments.filter(isComment) : [],
    lastOpenedAt: typeof parsed.lastOpenedAt === "number" ? parsed.lastOpenedAt : typeof parsed.updatedAt === "number" ? parsed.updatedAt : now,
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : now,
    deletedAt: typeof parsed.deletedAt === "number" ? parsed.deletedAt : null,
  };
}

function createDocumentId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function serializeEditorHtml(editor: HTMLElement): string {
  return sanitizeStoredHtml(editor.innerHTML);
}

export function sanitizeStoredHtml(html: string): string {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  wrap
    .querySelectorAll("script, style, iframe, object, embed, link, meta, base, form")
    .forEach((el) => el.remove());
  wrap
    .querySelectorAll("[data-page-break], [data-page-push], [data-caret-mark], .img-handle")
    .forEach((el) => el.remove());
  wrap.querySelectorAll(".grammar-flash").forEach((node) => {
    node.replaceWith(...node.childNodes);
  });
  wrap.querySelectorAll("*").forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc") node.removeAttribute(attr.name);
    }
    if (node instanceof HTMLAnchorElement) {
      const href = node.getAttribute("href") || "";
      if (href && !/^(https?:|mailto:|#)/i.test(href)) node.removeAttribute("href");
    }
    if (node instanceof HTMLImageElement) {
      const src = node.getAttribute("src") || "";
      if (src && !/^(https?:|data:image\/)/i.test(src)) node.removeAttribute("src");
    }
  });
  return wrap.innerHTML;
}

function cleanTitle(value: unknown) {
  if (typeof value !== "string") return "Untitled document";
  const title = value.replace(/\s+/g, " ").trim();
  return title || "Untitled document";
}

function isComment(value: unknown): value is StoredComment {
  if (!value || typeof value !== "object") return false;
  const comment = value as StoredComment;
  return (
    typeof comment.id === "string" &&
    typeof comment.quote === "string" &&
    typeof comment.body === "string"
  );
}

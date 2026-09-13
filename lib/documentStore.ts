export type StoredComment = {
  id: string;
  quote: string;
  body: string;
};

export type StoredDocument = {
  version: 1;
  title: string;
  html: string;
  headerText: string;
  footerText: string;
  showHeader: boolean;
  showFooter: boolean;
  showPageNumbers: boolean;
  columns: number;
  lineSpacing: string;
  comments: StoredComment[];
  updatedAt: number;
};

export const DOCUMENT_STORAGE_KEY = "inline-document-v1";

export function loadDocument(): StoredDocument | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DOCUMENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDocument>;
    if (typeof parsed.html !== "string") return null;
    return {
      version: 1,
      title: cleanTitle(parsed.title),
      html: parsed.html,
      headerText: typeof parsed.headerText === "string" ? parsed.headerText : "",
      footerText: typeof parsed.footerText === "string" ? parsed.footerText : "",
      showHeader: Boolean(parsed.showHeader),
      showFooter: Boolean(parsed.showFooter),
      showPageNumbers: Boolean(parsed.showPageNumbers),
      columns: parsed.columns === 2 || parsed.columns === 3 ? parsed.columns : 1,
      lineSpacing: typeof parsed.lineSpacing === "string" && parsed.lineSpacing ? parsed.lineSpacing : "1.15",
      comments: Array.isArray(parsed.comments) ? parsed.comments.filter(isComment) : [],
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveDocument(doc: Omit<StoredDocument, "version" | "updatedAt">) {
  if (typeof window === "undefined") return;
  const payload: StoredDocument = {
    version: 1,
    updatedAt: Date.now(),
    ...doc,
    title: cleanTitle(doc.title),
  };
  try {
    window.localStorage.setItem(DOCUMENT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota or private-mode failures should not break editing.
  }
}

export function serializeEditorHtml(editor: HTMLElement): string {
  const wrap = document.createElement("div");
  wrap.innerHTML = editor.innerHTML;
  return sanitizeStoredHtml(wrap.innerHTML);
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

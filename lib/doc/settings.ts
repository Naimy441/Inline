/**
 * Document-level settings and metadata shared by the server, the editor and
 * the agent tools. Everything here is plain JSON.
 */

export type PaperSize = "letter" | "a4" | "legal" | "statement";
export type Orientation = "portrait" | "landscape";
export type HorizontalAlign = "left" | "center" | "right";

/** Paper sizes in inches. */
export const PAPER_SIZES: Record<PaperSize, { label: string; width: number; height: number }> = {
  letter: { label: "Letter (8.5\" × 11\")", width: 8.5, height: 11 },
  a4: { label: "A4 (8.27\" × 11.69\")", width: 210 / 25.4, height: 297 / 25.4 },
  legal: { label: "Legal (8.5\" × 14\")", width: 8.5, height: 14 },
  statement: { label: "Statement (5.5\" × 8.5\")", width: 5.5, height: 8.5 },
};

export type Margins = { top: number; right: number; bottom: number; left: number };

export type PageSetup = {
  paperSize: PaperSize;
  orientation: Orientation;
  /** Inches. */
  margins: Margins;
};

export type HeaderFooterSettings = {
  /** Plain text; supports {page}, {pages}, {title} and {date}. */
  header: string;
  footer: string;
  headerAlign: HorizontalAlign;
  footerAlign: HorizontalAlign;
  differentFirstPage: boolean;
  firstHeader: string;
  firstFooter: string;
};

export type PageNumberSettings = {
  enabled: boolean;
  position: "header" | "footer";
  align: HorizontalAlign;
  /** Skip the number on the first page. */
  skipFirst: boolean;
};

export type DocumentSettings = {
  pageSetup: PageSetup;
  fontFamily: string;
  /** Points. */
  fontSize: number;
  lineSpacing: number;
  /** Points of space after each paragraph. */
  paragraphSpacing: number;
  headerFooter: HeaderFooterSettings;
  pageNumbers: PageNumberSettings;
};

export type DocumentMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  trashedAt: number | null;
  settings: DocumentSettings;
  wordCount: number;
  preview: string;
  /** True until someone names the document; meanwhile the title follows its first line, like Google Docs. */
  autoTitle?: boolean;
  /** Document tabs: set on every tab but the root (the tab the document began with), naming the root, which holds the title and the tab order. */
  parentId?: string;
  /** On the root tab: every tab's id in order (older files list only the tabs after it). */
  tabs?: string[];
  /** The tab's own name ("Tab 1" when unnamed). */
  tabTitle?: string;
  /** On the root tab: the folder the document is filed in (see lib/doc/folders.ts); unset at the top level. */
  folderId?: string;
  /** When the first-page thumbnail was last saved, and what it showed (a hash), so it's redrawn only when the page changes. */
  thumbnailAt?: number;
  thumbnailKey?: string;
};

/** One tab of a document, as the tabs list shows it. */
export type DocumentTab = { id: string; title: string; root?: boolean; outline?: TabHeading[] };
export type TabHeading = { pos: number; level: number; text: string };

export type CommentReply = { id: string; author: CommentAuthor; body: string; createdAt: number };
export type CommentAuthor = "user" | "claude";

export type DocComment = {
  id: string;
  author: CommentAuthor;
  body: string;
  /** Text the comment was anchored to when created (kept for orphaned comments). */
  quote: string;
  createdAt: number;
  resolved: boolean;
  replies: CommentReply[];
  /** Client only: a comment still being saved, and the text it's about. */
  pending?: { from: number; to: number };
};

export const FONT_FAMILIES = [
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Inter", value: "Inter, system-ui, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Times New Roman", value: "\"Times New Roman\", Times, serif" },
  { label: "EB Garamond", value: "\"EB Garamond\", Garamond, serif" },
  { label: "Merriweather", value: "Merriweather, Georgia, serif" },
  { label: "Roboto Mono", value: "\"Roboto Mono\", monospace" },
  { label: "Courier New", value: "\"Courier New\", Courier, monospace" },
] as const;

export const DEFAULT_SETTINGS: DocumentSettings = {
  pageSetup: { paperSize: "letter", orientation: "portrait", margins: { top: 1, right: 1, bottom: 1, left: 1 } },
  fontFamily: FONT_FAMILIES[0].value,
  fontSize: 11,
  lineSpacing: 1.15,
  paragraphSpacing: 8,
  headerFooter: {
    header: "",
    footer: "",
    headerAlign: "left",
    footerAlign: "center",
    differentFirstPage: false,
    firstHeader: "",
    firstFooter: "",
  },
  pageNumbers: { enabled: false, position: "footer", align: "right", skipFirst: false },
};

function num(value: unknown, fallback: number, min: number, max: number) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function str(value: unknown, fallback: string, maxLength = 500) {
  return typeof value === "string" ? value.slice(0, maxLength) : fallback;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

const ALIGNS = ["left", "center", "right"] as const;

export function normalizeSettings(input: unknown, base: DocumentSettings = DEFAULT_SETTINGS): DocumentSettings {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<Record<keyof DocumentSettings, unknown>>;
  const page = (raw.pageSetup && typeof raw.pageSetup === "object" ? raw.pageSetup : {}) as Partial<PageSetup>;
  const margins = (page.margins && typeof page.margins === "object" ? page.margins : {}) as Partial<Margins>;
  const hf = (raw.headerFooter && typeof raw.headerFooter === "object" ? raw.headerFooter : {}) as Partial<HeaderFooterSettings>;
  const pn = (raw.pageNumbers && typeof raw.pageNumbers === "object" ? raw.pageNumbers : {}) as Partial<PageNumberSettings>;
  return {
    pageSetup: {
      paperSize: oneOf(page.paperSize, Object.keys(PAPER_SIZES) as PaperSize[], base.pageSetup.paperSize),
      orientation: oneOf(page.orientation, ["portrait", "landscape"] as const, base.pageSetup.orientation),
      margins: {
        top: num(margins.top, base.pageSetup.margins.top, 0, 3),
        right: num(margins.right, base.pageSetup.margins.right, 0, 3),
        bottom: num(margins.bottom, base.pageSetup.margins.bottom, 0, 3),
        left: num(margins.left, base.pageSetup.margins.left, 0, 3),
      },
    },
    // A CSS font-family list; it is written into style sheets on export, so nothing that could end the declaration.
    fontFamily: str(raw.fontFamily, base.fontFamily, 200).replace(/[;{}<>\\]/g, "").trim() || base.fontFamily,
    fontSize: num(raw.fontSize, base.fontSize, 6, 96),
    lineSpacing: num(raw.lineSpacing, base.lineSpacing, 0.8, 4),
    paragraphSpacing: num(raw.paragraphSpacing, base.paragraphSpacing, 0, 72),
    headerFooter: {
      header: str(hf.header, base.headerFooter.header),
      footer: str(hf.footer, base.headerFooter.footer),
      headerAlign: oneOf(hf.headerAlign, ALIGNS, base.headerFooter.headerAlign),
      footerAlign: oneOf(hf.footerAlign, ALIGNS, base.headerFooter.footerAlign),
      differentFirstPage: typeof hf.differentFirstPage === "boolean" ? hf.differentFirstPage : base.headerFooter.differentFirstPage,
      firstHeader: str(hf.firstHeader, base.headerFooter.firstHeader),
      firstFooter: str(hf.firstFooter, base.headerFooter.firstFooter),
    },
    pageNumbers: {
      enabled: typeof pn.enabled === "boolean" ? pn.enabled : base.pageNumbers.enabled,
      position: oneOf(pn.position, ["header", "footer"] as const, base.pageNumbers.position),
      align: oneOf(pn.align, ALIGNS, base.pageNumbers.align),
      skipFirst: typeof pn.skipFirst === "boolean" ? pn.skipFirst : base.pageNumbers.skipFirst,
    },
  };
}

/** Deep-merge a partial settings patch onto existing settings. */
export function patchSettings(current: DocumentSettings, patch: unknown): DocumentSettings {
  if (!patch || typeof patch !== "object") return current;
  const p = patch as Record<string, unknown>;
  const merged = {
    ...current,
    ...p,
    pageSetup: {
      ...current.pageSetup,
      ...((p.pageSetup as object) ?? {}),
      margins: { ...current.pageSetup.margins, ...(((p.pageSetup as { margins?: object })?.margins) ?? {}) },
    },
    headerFooter: { ...current.headerFooter, ...((p.headerFooter as object) ?? {}) },
    pageNumbers: { ...current.pageNumbers, ...((p.pageNumbers as object) ?? {}) },
  };
  return normalizeSettings(merged, current);
}

/** The settings that decide where pages break, as a string, so a page count measured under other settings isn't trusted. */
export function layoutKey(settings: DocumentSettings) {
  const { paperSize, orientation, margins } = settings.pageSetup;
  return [paperSize, orientation, margins.top, margins.right, margins.bottom, margins.left, settings.fontFamily, settings.fontSize, settings.lineSpacing, settings.paragraphSpacing].join("|");
}

/** Page dimensions in inches, accounting for orientation. */
export function pageSize(setup: PageSetup) {
  const paper = PAPER_SIZES[setup.paperSize];
  return setup.orientation === "landscape" ? { width: paper.height, height: paper.width } : { width: paper.width, height: paper.height };
}

export function cleanTitle(value: unknown) {
  if (typeof value !== "string") return "Untitled document";
  const title = value.replace(/\s+/g, " ").trim().slice(0, 200);
  return title || "Untitled document";
}

/** A title from the document's first non-empty line, cut at a word boundary. */
export function titleFromText(firstLine: string) {
  const line = firstLine.replace(/\s+/g, " ").trim();
  if (!line) return null;
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

export function fillHeaderTokens(text: string, context: { page: number; pages: number; title: string; date?: Date }) {
  if (!text.includes("{")) return text;
  return text
    .replace(/\{page\}/gi, String(context.page))
    .replace(/\{pages\}/gi, String(context.pages))
    .replace(/\{title\}/gi, () => context.title)
    .replace(/\{date\}/gi, () => (context.date ?? new Date()).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }));
}

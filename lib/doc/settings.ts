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
  /**
   * An exact page size in inches (portrait: width ≤ height), for pages none of
   * the paper sizes fit, such as an imported PDF of slides. `paperSize` is then
   * the nearest one, and choosing a paper size clears this.
   */
  customSize?: { width: number; height: number };
};

export type HeaderFooterSettings = {
  /**
   * Plain text; supports {page}, {pages}, {title} and {date}. Tabs split it in
   * two or three parts set at the left, (center) and right, as Word's header
   * tab stops do: "Course\tWeek 7\tPage {page}".
   */
  header: string;
  footer: string;
  headerAlign: HorizontalAlign;
  footerAlign: HorizontalAlign;
  differentFirstPage: boolean;
  firstHeader: string;
  firstFooter: string;
  /** A rule under the header, as LaTeX's fancyhdr draws one. */
  headerRule?: boolean;
  /**
   * Inches from the top of the page to the top of the header text, and from
   * the bottom of the page to the bottom of the footer text (Word's "header
   * from top" and "footer from bottom"). Unset: just inside the margin.
   */
  headerFrom?: number;
  footerFrom?: number;
  /** The header and footer's text size in points and color (#rrggbb), when not the page's usual small grey. */
  size?: number;
  color?: string;
  /** The running header's parts' sizes (left, center, right), when they differ. */
  headerPartSizes?: number[];
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
  /**
   * "font": line spacing is a multiple of each font's own line height, as in
   * Google Docs and Word (see lib/doc/fontMetrics.ts); imported documents are
   * laid out so. Unset: a multiple of the font size.
   */
  lineModel?: "font";
  /** Points between the default tab stops, when not Google's and Word's half inch. */
  tabStop?: number;
  /** Equations' size against their text, when not the usual 1.1 (a PDF made with LaTeX sets them at 1). */
  mathSize?: number;
};

/** Equations' usual size against their text. */
export const DEFAULT_MATH_SIZE = 1.1;

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
  /** Set on a document imported from a PDF (lib/server/pdfImports.ts). */
  pdfImport?: PdfImportMeta;
};

/**
 * A document imported from a PDF: its original pages, which of them had
 * annotations (handwriting, highlighting, notes) that were left out, whether
 * they are shown over the pages as they were, and how far Claude is with
 * rebuilding the pages as editable text.
 */
export type PdfImportMeta = {
  pages: number;
  /** Original pages (1-based) that had annotations. */
  inkPages: number[];
  showAnnotations: boolean;
  /** "pending": the pages are still pictures; "converting": Claude is on it; "done": every page is text. */
  status: "pending" | "converting" | "done";
  /** Pages Claude has rebuilt so far. */
  converted: number[];
  /** The chat converting it. */
  chatId?: string;
};

export function normalizePdfImportMeta(value: unknown): PdfImportMeta | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PdfImportMeta>;
  const pages = Number(raw.pages);
  if (!Number.isInteger(pages) || pages < 1) return null;
  const list = (input: unknown) => (Array.isArray(input) ? [...new Set(input.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= pages))].sort((a, b) => a - b) : []);
  return {
    pages,
    inkPages: list(raw.inkPages),
    showAnnotations: raw.showAnnotations === true,
    status: raw.status === "converting" || raw.status === "done" ? raw.status : "pending",
    converted: list(raw.converted),
    ...(typeof raw.chatId === "string" && raw.chatId ? { chatId: raw.chatId } : {}),
  };
}

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

/** A Google Fonts family (lib/server/googleFonts.ts) and its kind. */
export type GoogleFont = { family: string; category: "sans-serif" | "serif" | "display" | "handwriting" | "monospace" };

/** The CSS font-family a Google font is set as: the family, then a generic one like it. */
export function googleFontValue(font: GoogleFont) {
  const generic = font.category === "serif" ? "serif" : font.category === "monospace" ? "monospace" : font.category === "handwriting" ? "cursive" : "sans-serif";
  return `"${font.family}", ${generic}`;
}

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
      ...(() => {
        const custom = (page.customSize === undefined ? base.pageSetup.customSize : page.customSize) as { width?: unknown; height?: unknown } | null | undefined;
        if (!custom || typeof custom !== "object") return {};
        const width = Number(custom.width);
        const height = Number(custom.height);
        if (!(width >= 1 && width <= 48 && height >= 1 && height <= 48)) return {};
        return { customSize: { width: Math.min(width, height), height: Math.max(width, height) } };
      })(),
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
      ...((typeof hf.headerRule === "boolean" ? hf.headerRule : base.headerFooter.headerRule) ? { headerRule: true } : {}),
      ...(() => {
        const distance = (value: unknown, fallback: number | undefined) => {
          const n = value === undefined ? fallback : value === null ? undefined : Number(value);
          return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 3 ? Math.round(n * 1000) / 1000 : undefined;
        };
        const headerFrom = distance(hf.headerFrom, base.headerFooter.headerFrom);
        const footerFrom = distance(hf.footerFrom, base.headerFooter.footerFrom);
        return { ...(headerFrom !== undefined ? { headerFrom } : {}), ...(footerFrom !== undefined ? { footerFrom } : {}) };
      })(),
      ...(() => {
        const size = hf.size === undefined ? base.headerFooter.size : hf.size === null ? undefined : Number(hf.size);
        const color = hf.color === undefined ? base.headerFooter.color : hf.color === null ? undefined : String(hf.color);
        return {
          ...(typeof size === "number" && size >= 4 && size <= 72 ? { size: Math.round(size * 10) / 10 } : {}),
          ...(typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? { color: color.toLowerCase() } : {}),
          ...(() => {
            const sizes = hf.headerPartSizes === undefined ? base.headerFooter.headerPartSizes : hf.headerPartSizes;
            return Array.isArray(sizes) && sizes.length <= 3 && sizes.every((item) => typeof item === "number" && item >= 4 && item <= 72) ? { headerPartSizes: sizes.map((item) => Math.round(item * 10) / 10) } : {};
          })(),
        };
      })(),
    },
    pageNumbers: {
      enabled: typeof pn.enabled === "boolean" ? pn.enabled : base.pageNumbers.enabled,
      position: oneOf(pn.position, ["header", "footer"] as const, base.pageNumbers.position),
      align: oneOf(pn.align, ALIGNS, base.pageNumbers.align),
      skipFirst: typeof pn.skipFirst === "boolean" ? pn.skipFirst : base.pageNumbers.skipFirst,
    },
    ...((raw.lineModel === undefined ? base.lineModel : raw.lineModel) === "font" ? { lineModel: "font" as const } : {}),
    ...(() => {
      const stop = raw.tabStop === undefined ? base.tabStop : raw.tabStop;
      return typeof stop === "number" && Number.isFinite(stop) && stop >= 1 && stop <= 360 && stop !== DEFAULT_TAB_STOP ? { tabStop: stop } : {};
    })(),
    ...(() => {
      const size = raw.mathSize === undefined ? base.mathSize : raw.mathSize;
      return typeof size === "number" && Number.isFinite(size) && size >= 0.5 && size <= 2 && size !== DEFAULT_MATH_SIZE ? { mathSize: Math.round(size * 100) / 100 } : {};
    })(),
  };
}

/** Google Docs' and Word's default tab stops: every half inch, in points. */
export const DEFAULT_TAB_STOP = 36;

/** Deep-merge a partial settings patch onto existing settings. */
export function patchSettings(current: DocumentSettings, patch: unknown): DocumentSettings {
  if (!patch || typeof patch !== "object") return current;
  const p = patch as Record<string, unknown>;
  const merged = {
    ...current,
    ...p,
    pageSetup: {
      ...current.pageSetup,
      // Choosing a paper size gives up an imported page's own size.
      ...((p.pageSetup as { paperSize?: unknown })?.paperSize !== undefined && (p.pageSetup as { customSize?: unknown }).customSize === undefined ? { customSize: null } : {}),
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
  const { paperSize, orientation, margins, customSize } = settings.pageSetup;
  return [customSize ? `${customSize.width}x${customSize.height}` : paperSize, orientation, margins.top, margins.right, margins.bottom, margins.left, settings.fontFamily, settings.fontSize, settings.lineSpacing, settings.paragraphSpacing, ...(settings.lineModel ? [settings.lineModel] : []), ...(settings.tabStop ? [`tab ${settings.tabStop}`] : []), ...(settings.mathSize ? [`math ${settings.mathSize}`] : [])].join("|");
}

/** Page dimensions in inches, accounting for orientation. */
export function pageSize(setup: PageSetup) {
  const paper = setup.customSize ?? PAPER_SIZES[setup.paperSize];
  return setup.orientation === "landscape" ? { width: paper.height, height: paper.width } : { width: paper.width, height: paper.height };
}

export function cleanTitle(value: unknown) {
  if (typeof value !== "string") return "Untitled document";
  const title = value.replace(/\s+/g, " ").trim().slice(0, 200);
  return title || "Untitled document";
}

/**
 * How long a title that follows the first line may grow. Long enough to tell
 * documents apart, short enough for the title bar while the line is still being typed.
 */
const LIVE_TITLE_MAX = 48;

/**
 * A title from the document's first non-empty line.
 * A short line is kept whole, including the word being typed. A longer line is
 * cut on a word boundary and marked with an ellipsis. The cut is a prefix of
 * the line, so once the title settles it stays put as more is typed: it does
 * not jump around or end in the middle of a word.
 */
export function titleFromText(firstLine: string) {
  const line = firstLine.replace(/\s+/g, " ").trim();
  if (!line) return null;
  if (line.length <= LIVE_TITLE_MAX) return line;
  const cut = line.slice(0, LIVE_TITLE_MAX);
  const space = cut.lastIndexOf(" ");
  const shortened = (space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "");
  return `${shortened || cut.slice(0, LIVE_TITLE_MAX)}…`;
}

/** A header or footer's parts: one (set by its alignment), or two or three split by tabs (left, center, right). */
export function headerParts(text: string): string[] {
  return text.split("\t").map((part) => part.trim());
}

export function fillHeaderTokens(text: string, context: { page: number; pages: number; title: string; date?: Date }) {
  if (!text.includes("{")) return text;
  return text
    .replace(/\{page\}/gi, String(context.page))
    .replace(/\{pages\}/gi, String(context.pages))
    .replace(/\{title\}/gi, () => context.title)
    .replace(/\{date\}/gi, () => (context.date ?? new Date()).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }));
}

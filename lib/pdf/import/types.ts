/**
 * What Inline learns from a PDF it imports. The browser reads the PDF with
 * pdf.js (lib/pdf/import/prepare.ts), works out what each page holds and
 * sends this along with the page pictures; Claude reads it through the PDF
 * tools (lib/agent/pdfTools.ts) while it rebuilds the pages as a document.
 *
 * Positions are in PDF points (1/72 inch) from the top left of the page as
 * it is shown (rotation applied).
 */

export type PdfBox = { x: number; y: number; width: number; height: number };

/** A run of text in one style. */
export type PdfTextRun = {
  text: string;
  x: number;
  width: number;
  /** Font size in points. */
  size: number;
  /** The font's name without its subset tag ("CMBX12", "TimesNewRomanPS-BoldMT"). */
  font: string;
  bold: boolean;
  italic: boolean;
  /** A big gap (a tab stop, a column) comes before this run. */
  gapBefore?: boolean;
};

/** One line of text as it sits on the page. */
export type PdfTextLine = {
  /** The line's text; a big gap between words (a tab, a column) is a tab character. */
  text: string;
  box: PdfBox;
  /** Baseline, from the top of the page. */
  baseline: number;
  /** The size most of the line is set in. */
  size: number;
  font: string;
  bold: boolean;
  italic: boolean;
  runs: PdfTextRun[];
};

/** A picture placed on a page. */
export type PdfImagePlacement = {
  /** "p3-i2": the second picture on page 3. */
  id: string;
  box: PdfBox;
  /** Its own size in pixels. */
  pixelWidth: number;
  pixelHeight: number;
  /** The upload it was saved as (filled in when the import is stored). */
  url?: string;
  /** pdf.js's name for it, to share one file between placements (not stored). */
  object?: string;
  /** The upload form field carrying its file (not stored). */
  asset?: string;
};

export type PdfLink = { box: PdfBox; url?: string; page?: number; text?: string };

/** A line or a box drawn on the page (rules, frames around text). */
export type PdfRule = { kind: "hline" | "vline" | "frame"; box: PdfBox; width: number; color: string };

/** Annotations found on a page: written, drawn or marked up on top of it. */
export type PdfInkSummary = {
  /** How many drawing operations were annotations. */
  count: number;
  box: PdfBox | null;
  /** Where they came from: "pen" (drawing flattened into the page), "highlighter", "image", or a PDF annotation type ("Ink", "Highlight", "FreeText"…). */
  kinds: string[];
  /** Notes typed into annotations (sticky notes, comments on highlights). */
  notes: Array<{ text: string; box: PdfBox; kind: string }>;
};

export type PdfPageAnalysis = {
  /** 1-based. */
  page: number;
  width: number;
  height: number;
  lines: PdfTextLine[];
  images: PdfImagePlacement[];
  links: PdfLink[];
  rules: PdfRule[];
  /** Drawings made of lines and curves (charts, diagrams), worth cropping as pictures. */
  graphics: PdfBox[];
  ink: PdfInkSummary;
  /** No text layer: a scan or a picture of a page. */
  scanned: boolean;
};

export type PdfHeaderFooter = { text: string; parts: string[]; y: number; size: number; pages: number[]; align: "left" | "center" | "right" };

/** What holds across the pages: margins, the main font, header and footer. */
export type PdfDocumentSummary = {
  /** Inches, from where the text sits. */
  margins: { top: number; right: number; bottom: number; left: number };
  bodyFont: string;
  bodySize: number;
  /** Baseline to baseline over the font size, for the main text. */
  lineSpacing: number;
  /** Points between paragraphs of the main text, beyond the line spacing. */
  paragraphSpacing: number;
  header: PdfHeaderFooter | null;
  footer: PdfHeaderFooter | null;
  /** Page numbers printed on the pages, and where. */
  pageNumbers: { position: "header" | "footer"; align: "left" | "center" | "right" } | null;
  /** Fonts by how much text is set in them. */
  fonts: Array<{ name: string; bold: boolean; italic: boolean; chars: number; sizes: number[] }>;
  /** A rule under the header (LaTeX's fancyhdr, Word's header border). */
  headerRule: boolean;
};

export type PdfImportManifest = {
  version: 1;
  fileName: string;
  title: string | null;
  pageCount: number;
  pages: PdfPageAnalysis[];
  summary: PdfDocumentSummary;
  /** Pixels per point of the stored page pictures. */
  renderScale: number;
};

/** The pictures of one page the browser makes. */
export type PdfPageRenders = {
  /** The page without annotations, at `renderScale`. */
  clean: Blob;
  /** Only the annotations, on a transparent page, at `renderScale`; null when the page has none. */
  ink: Blob | null;
};

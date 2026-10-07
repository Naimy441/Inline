/**
 * How tall a line of each font is, the way Google Docs (and Word) lay text
 * out: "single" line spacing is the font's own line height, not 1em, so 1.15
 * spacing in Arial is 1.15 × 1.15em. A document whose settings say
 * `lineModel: "font"` (every imported Word or Google document) is laid out
 * this way; see app/styles/document.css.
 *
 * The figures are each font's ascent, descent and line gap in ems, as Google
 * Docs uses them, measured from PDFs Google Docs made. Google uses the font's
 * own metrics for the fonts Windows ships, but not for every web font: it
 * sets Crimson Text 1.2em high (the font says 1.3) and rounds its lines to
 * whole pixels.
 */

export type LineMetrics = {
  /** Baseline below the top of the line, in ems. */
  ascent: number;
  /** Below the baseline, in ems. */
  descent: number;
  /** Extra space a line takes beyond ascent and descent, in ems. */
  gap?: number;
  /** Lines are rounded to whole CSS pixels. */
  pixelRound?: boolean;
};

const em = (ascent: number, descent: number, gap: number, unitsPerEm: number, pixelRound?: boolean): LineMetrics => ({
  ascent: ascent / unitsPerEm,
  descent: descent / unitsPerEm,
  gap: gap / unitsPerEm,
  ...(pixelRound ? { pixelRound } : {}),
});

const KNOWN: Record<string, LineMetrics> = {
  arial: em(1854, 434, 67, 2048),
  helvetica: em(1854, 434, 67, 2048),
  "times new roman": em(1825, 443, 87, 2048),
  times: em(1825, 443, 87, 2048),
  calibri: em(1536, 512, 452, 2048),
  cambria: em(1946, 455, 0, 2048),
  georgia: em(1878, 449, 0, 2048),
  "courier new": em(1705, 615, 0, 2048),
  courier: em(1705, 615, 0, 2048),
  verdana: em(2059, 430, 0, 2048),
  tahoma: em(2049, 423, 0, 2048),
  "trebuchet ms": em(1923, 455, 0, 2048),
  "comic sans ms": em(2257, 597, 0, 2048),
  "roboto mono": em(2146, 555, 0, 2048),
  lato: em(1974, 426, 0, 2000),
  roboto: em(1900, 558, 0, 2048),
  "crimson text": em(972, 257, 0, 1024, true),
};

/** What Google Docs uses for a font it has no figures for. */
const DEFAULT: LineMetrics = { ascent: 0.95, descent: 0.25 };

/** The first family of a CSS font-family list, unquoted. */
export function primaryFamily(family: string) {
  return (family.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
}

export function lineMetrics(family: string): LineMetrics {
  return KNOWN[primaryFamily(family).toLowerCase()] ?? DEFAULT;
}

/** A font's "single" line height, in ems. */
export function lineFactor(family: string) {
  const metrics = lineMetrics(family);
  return Number((metrics.ascent + metrics.descent + (metrics.gap ?? 0)).toFixed(4));
}

/**
 * CSS custom properties that size lines of this font (see document.css):
 * its line height in ems, and the step lines are rounded to.
 */
export function lineVars(family: string) {
  return `--font-lh: ${lineFactor(family)}; --font-lh-step: ${lineMetrics(family).pixelRound ? "1px" : "0.01px"}`;
}

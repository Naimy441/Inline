/**
 * Named paragraph styles and document themes.
 *
 * A style is font, size, spacing and the style of the next paragraph. It can
 * be based on another style. Paragraphs point at a style; they do not copy
 * it. Changing the style changes every paragraph that uses it, and every
 * style that inherits from it. Direct formatting on a paragraph (its own
 * size, spacing, or a font or color on its text) still wins for that
 * paragraph only.
 *
 * A theme is the heading font, the body font and a color set. Styles refer
 * to those, so switching the theme restyles the document without renaming a
 * style or rewriting a word.
 */

export type ThemeFont = "body" | "heading";
export type ThemeColor = "text" | "background" | "accent1" | "accent2" | "accent3" | "accent4" | "accent5" | "accent6";

export type FontRef = { theme: ThemeFont } | { family: string };
export type ColorRef = { theme: ThemeColor } | { hex: string };

export type ParagraphStyle = {
  id: string;
  name: string;
  basedOn: string | null;
  /** The style a new paragraph takes when this one is split. */
  next: string | null;
  /** Null inherits from the style this one is based on. */
  font: FontRef | null;
  /** Points. Null inherits. */
  size: number | null;
  /** Points. Null inherits. */
  spaceBefore: number | null;
  spaceAfter: number | null;
  /** A multiple of the font size. Null inherits. */
  lineHeight: number | null;
  color: ColorRef | null;
  italic: boolean | null;
};

export type ThemeColors = Record<ThemeColor, string>;

export type DocumentTheme = {
  id: string;
  name: string;
  /** CSS font-family. */
  headingFont: string;
  bodyFont: string;
  colors: ThemeColors;
};

export type StyleRole = "paragraph" | "title" | "subtitle" | "heading" | "quote" | "code";

const NEUTRAL: ThemeColors = {
  text: "#202124",
  background: "#ffffff",
  accent1: "#202124",
  accent2: "#434343",
  accent3: "#666666",
  accent4: "#1a73e8",
  accent5: "#188038",
  accent6: "#c5221f",
};

/** Themes a document can switch to. "Inline" is today's page: one font, near-black text. */
export const DOCUMENT_THEMES: DocumentTheme[] = [
  {
    id: "inline",
    name: "Inline",
    headingFont: "Arial, Helvetica, sans-serif",
    bodyFont: "Arial, Helvetica, sans-serif",
    colors: NEUTRAL,
  },
  {
    id: "classic",
    name: "Classic",
    headingFont: "Georgia, serif",
    bodyFont: '"Times New Roman", Times, serif',
    colors: {
      text: "#1c1917",
      background: "#fffdf8",
      accent1: "#1e3a5f",
      accent2: "#7c2d12",
      accent3: "#57534e",
      accent4: "#1e3a5f",
      accent5: "#3f6212",
      accent6: "#9f1239",
    },
  },
  {
    id: "modern",
    name: "Modern",
    headingFont: "Inter, system-ui, sans-serif",
    bodyFont: "Arial, Helvetica, sans-serif",
    colors: {
      text: "#0f172a",
      background: "#ffffff",
      accent1: "#1d4ed8",
      accent2: "#0f766e",
      accent3: "#475569",
      accent4: "#7c3aed",
      accent5: "#0369a1",
      accent6: "#be123c",
    },
  },
  {
    id: "editorial",
    name: "Editorial",
    headingFont: '"EB Garamond", Garamond, serif',
    bodyFont: "Georgia, serif",
    colors: {
      text: "#292524",
      background: "#faf7f2",
      accent1: "#9a3412",
      accent2: "#44403c",
      accent3: "#78716c",
      accent4: "#1c1917",
      accent5: "#3f6212",
      accent6: "#9f1239",
    },
  },
];

const style = (partial: ParagraphStyle): ParagraphStyle => partial;

/**
 * The block types the page already had, as a real stylesheet. Sizes and
 * spacing match app/styles/document.css so an existing document opens
 * looking as it did.
 */
export const BUILTIN_STYLES: ParagraphStyle[] = [
  style({ id: "Normal", name: "Normal", basedOn: null, next: "Normal", font: { theme: "body" }, size: null, spaceBefore: null, spaceAfter: null, lineHeight: null, color: { theme: "text" }, italic: null }),
  style({ id: "Title", name: "Title", basedOn: "Normal", next: "Normal", font: { theme: "heading" }, size: 26, spaceBefore: 0, spaceAfter: 3, lineHeight: 1.15, color: { theme: "accent1" }, italic: null }),
  style({ id: "Subtitle", name: "Subtitle", basedOn: "Normal", next: "Normal", font: { theme: "body" }, size: 15, spaceBefore: 0, spaceAfter: 16, lineHeight: null, color: { theme: "accent3" }, italic: null }),
  style({ id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", font: { theme: "heading" }, size: 20, spaceBefore: 20, spaceAfter: 6, lineHeight: 1.2, color: { theme: "accent1" }, italic: null }),
  style({ id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", font: { theme: "heading" }, size: 16, spaceBefore: 18, spaceAfter: 6, lineHeight: 1.2, color: { theme: "accent1" }, italic: null }),
  style({ id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", font: { theme: "heading" }, size: 14, spaceBefore: 16, spaceAfter: 4, lineHeight: 1.2, color: { theme: "accent2" }, italic: null }),
  style({ id: "Heading4", name: "Heading 4", basedOn: "Normal", next: "Normal", font: { theme: "heading" }, size: 12, spaceBefore: 14, spaceAfter: 4, lineHeight: 1.2, color: { theme: "accent3" }, italic: null }),
  style({ id: "Heading5", name: "Heading 5", basedOn: "Heading4", next: "Normal", font: null, size: 11, spaceBefore: 12, spaceAfter: 4, lineHeight: 1.2, color: { theme: "accent3" }, italic: null }),
  style({ id: "Heading6", name: "Heading 6", basedOn: "Heading4", next: "Normal", font: null, size: 11, spaceBefore: 12, spaceAfter: 4, lineHeight: 1.2, color: { theme: "accent3" }, italic: true }),
  style({ id: "Quote", name: "Quote", basedOn: "Normal", next: "Normal", font: null, size: null, spaceBefore: null, spaceAfter: null, lineHeight: null, color: { hex: "#555555" }, italic: null }),
  style({ id: "Code", name: "Code", basedOn: "Normal", next: "Normal", font: { family: '"Roboto Mono", ui-monospace, monospace' }, size: null, spaceBefore: null, spaceAfter: null, lineHeight: 1.5, color: null, italic: null }),
];

const BUILTIN_BY_ID = new Map(BUILTIN_STYLES.map((item) => [item.id, item]));

export const BUILTIN_STYLE_IDS = new Set(BUILTIN_STYLES.map((item) => item.id));

const ROLE: Record<string, { role: StyleRole; level: number }> = {
  Normal: { role: "paragraph", level: 1 },
  Title: { role: "title", level: 1 },
  Subtitle: { role: "subtitle", level: 1 },
  Heading1: { role: "heading", level: 1 },
  Heading2: { role: "heading", level: 2 },
  Heading3: { role: "heading", level: 3 },
  Heading4: { role: "heading", level: 4 },
  Heading5: { role: "heading", level: 5 },
  Heading6: { role: "heading", level: 6 },
  Quote: { role: "quote", level: 1 },
  Code: { role: "code", level: 1 },
};

export function isBuiltinStyle(id: string) {
  return BUILTIN_STYLE_IDS.has(id);
}

export function findStyle(sheet: readonly ParagraphStyle[], id: string | null | undefined) {
  if (!id) return undefined;
  return sheet.find((item) => item.id === id);
}

/** Built-ins, with anything the document has saved laid over them, then styles the document added. */
export function stylesOf(settings: { styles?: ParagraphStyle[] | null }): ParagraphStyle[] {
  if (!settings.styles?.length) return BUILTIN_STYLES.map((item) => ({ ...item }));
  const overlay = new Map(settings.styles.map((item) => [item.id, item]));
  const builtins = BUILTIN_STYLES.map((item) => overlay.get(item.id) ?? { ...item });
  const extra = settings.styles.filter((item) => !BUILTIN_STYLE_IDS.has(item.id));
  return [...builtins, ...extra];
}

/** The theme on the page. With none saved, body and heading follow the document font and the colors stay neutral. */
export function activeTheme(settings: { fontFamily: string; theme?: DocumentTheme | null }): DocumentTheme {
  if (settings.theme) return settings.theme;
  const base = DOCUMENT_THEMES[0]!;
  return { ...base, headingFont: settings.fontFamily, bodyFont: settings.fontFamily, colors: { ...base.colors } };
}

export function themeById(id: string) {
  return DOCUMENT_THEMES.find((theme) => theme.id === id) ?? null;
}

export type ResolvedStyle = {
  id: string;
  name: string;
  basedOn: string | null;
  next: string | null;
  font: FontRef | null;
  size: number | null;
  spaceBefore: number | null;
  spaceAfter: number | null;
  lineHeight: number | null;
  color: ColorRef | null;
  italic: boolean;
};

/** Walk basedOn from the root down so a change to a base style shows up in everything that inherits it. */
export function resolveStyle(sheet: readonly ParagraphStyle[], id: string | null | undefined): ResolvedStyle | null {
  if (!id) return null;
  const chain: ParagraphStyle[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const found = findStyle(sheet, current);
    if (!found) break;
    chain.unshift(found);
    current = found.basedOn;
  }
  const self = chain[chain.length - 1];
  if (!self || self.id !== id) return null;
  const resolved: ResolvedStyle = {
    id: self.id,
    name: self.name,
    basedOn: self.basedOn,
    next: self.next,
    font: null,
    size: null,
    spaceBefore: null,
    spaceAfter: null,
    lineHeight: null,
    color: null,
    italic: false,
  };
  for (const item of chain) {
    if (item.font) resolved.font = item.font;
    if (item.size != null) resolved.size = item.size;
    if (item.spaceBefore != null) resolved.spaceBefore = item.spaceBefore;
    if (item.spaceAfter != null) resolved.spaceAfter = item.spaceAfter;
    if (item.lineHeight != null) resolved.lineHeight = item.lineHeight;
    if (item.color) resolved.color = item.color;
    if (item.italic != null) resolved.italic = item.italic;
  }
  resolved.next = self.next;
  resolved.basedOn = self.basedOn;
  return resolved;
}

/** The block a style is: its own, or the nearest built-in it is based on. */
export function structuralRole(sheet: readonly ParagraphStyle[], id: string): { role: StyleRole; level: number } {
  const seen = new Set<string>();
  let current: string | null = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const known = ROLE[current];
    if (known) return known;
    current = findStyle(sheet, current)?.basedOn ?? null;
  }
  return { role: "paragraph", level: 1 };
}

/** The style id a block has, stated or implied by its type, so old documents still open. */
export function nodeStyleId(node: { type: { name: string }; attrs: { style?: unknown; level?: unknown } }): string {
  const explicit = node.attrs.style;
  if (typeof explicit === "string" && explicit) return explicit;
  switch (node.type.name) {
    case "title":
      return "Title";
    case "subtitle":
      return "Subtitle";
    case "heading":
      return `Heading${Math.min(6, Math.max(1, Number(node.attrs.level) || 1))}`;
    case "blockquote":
      return "Quote";
    case "code_block":
      return "Code";
    default:
      return "Normal";
  }
}

export function impliedStyleId(role: StyleRole, level = 1) {
  switch (role) {
    case "title":
      return "Title";
    case "subtitle":
      return "Subtitle";
    case "heading":
      return `Heading${level}`;
    case "quote":
      return "Quote";
    case "code":
      return "Code";
    default:
      return "Normal";
  }
}

/** Stored on the node only when it isn't what the block type already means. */
export function storedStyleId(styleId: string, role: { role: StyleRole; level: number }) {
  return styleId === impliedStyleId(role.role, role.level) ? null : styleId;
}

export function wouldCycle(sheet: readonly ParagraphStyle[], id: string, basedOn: string | null) {
  const seen = new Set<string>([id]);
  let current = basedOn;
  while (current) {
    if (seen.has(current)) return true;
    seen.add(current);
    current = findStyle(sheet, current)?.basedOn ?? null;
  }
  return false;
}

export function newStyleId() {
  return `S${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * A style id taken from the name the person typed, when that id is free.
 * "Callout" stays Callout; "My style" becomes Mystyle. A name that collides
 * with Normal or Heading1 keeps the generated id instead.
 */
export function styleIdFromName(name: string, taken: ReadonlySet<string>) {
  const compact = name.trim().replace(/[^A-Za-z0-9_-]+/g, "");
  const id = safeStyleId(compact);
  if (!id || taken.has(id)) return null;
  return id;
}

const THEME_COLOR_WORD: Record<ThemeColor, string> = {
  text: "dark1",
  background: "light1",
  accent1: "accent1",
  accent2: "accent2",
  accent3: "accent3",
  accent4: "accent4",
  accent5: "accent5",
  accent6: "accent6",
};

const WORD_THEME_COLOR: Record<string, ThemeColor> = {
  dark1: "text",
  light1: "background",
  accent1: "accent1",
  accent2: "accent2",
  accent3: "accent3",
  accent4: "accent4",
  accent5: "accent5",
  accent6: "accent6",
};

function numOrNull(value: unknown, min: number, max: number) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}

function fontRef(value: unknown): FontRef | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { theme?: unknown; family?: unknown };
  if (raw.theme === "body" || raw.theme === "heading") return { theme: raw.theme };
  if (typeof raw.family === "string" && safeFontFamily(raw.family)) return { family: safeFontFamily(raw.family) };
  return null;
}

function colorRef(value: unknown): ColorRef | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { theme?: unknown; hex?: unknown };
  if (typeof raw.theme === "string" && raw.theme in NEUTRAL) return { theme: raw.theme as ThemeColor };
  if (typeof raw.hex === "string" && /^#[0-9a-f]{6}$/i.test(raw.hex)) return { hex: raw.hex.toLowerCase() };
  return null;
}

export function normalizeStyle(value: unknown): ParagraphStyle | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<ParagraphStyle>;
  const id = typeof raw.id === "string" ? safeStyleId(raw.id) : null;
  if (!id) return null;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 80) : id;
  const basedOn = typeof raw.basedOn === "string" ? safeStyleId(raw.basedOn) : null;
  const next = typeof raw.next === "string" ? safeStyleId(raw.next) : null;
  return {
    id,
    name,
    basedOn,
    next,
    font: fontRef(raw.font),
    size: numOrNull(raw.size, 1, 96),
    spaceBefore: numOrNull(raw.spaceBefore, 0, 200),
    spaceAfter: numOrNull(raw.spaceAfter, 0, 200),
    lineHeight: numOrNull(raw.lineHeight, 0.8, 4),
    color: colorRef(raw.color),
    italic: raw.italic == null ? null : Boolean(raw.italic),
  };
}

export function normalizeStyleSheet(input: unknown): ParagraphStyle[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const styles = input.map(normalizeStyle).filter((item): item is ParagraphStyle => Boolean(item));
  const seen = new Set<string>();
  const unique = styles.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
  if (!unique.length) return undefined;
  return stylesOf({ styles: unique });
}

export function normalizeTheme(input: unknown): DocumentTheme | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Partial<DocumentTheme> & { colors?: Partial<ThemeColors> };
  const headingFont = typeof raw.headingFont === "string" ? safeFontFamily(raw.headingFont) : "";
  const bodyFont = typeof raw.bodyFont === "string" ? safeFontFamily(raw.bodyFont) : "";
  if (!headingFont || !bodyFont) return undefined;
  const colors = {} as ThemeColors;
  for (const key of Object.keys(NEUTRAL) as ThemeColor[]) {
    const value = raw.colors?.[key];
    colors[key] = typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : NEUTRAL[key];
  }
  const id = typeof raw.id === "string" && /^[a-z0-9-]{1,40}$/.test(raw.id) ? raw.id : "custom";
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 40) : "Custom";
  return { id, name, headingFont, bodyFont, colors };
}

export function safeStyleId(value: string) {
  return /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(value) ? value : null;
}

export function safeFontFamily(value: string) {
  const cleaned = value.replace(/[;{}<>\\]/g, "").trim();
  return cleaned.slice(0, 200);
}

function cssEscape(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, "");
}

export function resolvedColorHex(color: ColorRef | null, theme: DocumentTheme): string | null {
  if (!color) return null;
  return "hex" in color ? color.hex : theme.colors[color.theme];
}

export function resolvedFontFamily(font: FontRef | null, theme: DocumentTheme): string | null {
  if (!font) return null;
  return "family" in font ? font.family : font.theme === "heading" ? theme.headingFont : theme.bodyFont;
}

function sameFont(a: FontRef | null, b: FontRef | null) {
  if (!a || !b) return !a && !b;
  if ("theme" in a && "theme" in b) return a.theme === b.theme;
  if ("family" in a && "family" in b) return a.family === b.family;
  return false;
}

function sameColor(a: ColorRef | null, b: ColorRef | null) {
  if (!a || !b) return !a && !b;
  if ("theme" in a && "theme" in b) return a.theme === b.theme;
  if ("hex" in a && "hex" in b) return a.hex.toLowerCase() === b.hex.toLowerCase();
  return false;
}

function sameStyle(a: ParagraphStyle, b: ParagraphStyle) {
  return a.name === b.name && a.basedOn === b.basedOn && a.next === b.next && a.size === b.size && a.spaceBefore === b.spaceBefore && a.spaceAfter === b.spaceAfter && a.lineHeight === b.lineHeight && a.italic === b.italic && sameFont(a.font, b.font) && sameColor(a.color, b.color);
}

/** Styles worth saving: ones the document changed or added. Undefined when nothing differs from the built-in sheet. */
export function stylesToStore(sheet: readonly ParagraphStyle[]): ParagraphStyle[] | undefined {
  const changed = sheet.filter((item) => {
    const builtin = BUILTIN_BY_ID.get(item.id);
    return !builtin || !sameStyle(item, builtin);
  });
  return changed.length ? changed : undefined;
}

/** What switching to a built-in theme writes. Inline clears the stored theme so the page colors (including dark mode) stay in charge. */
export function themeChoice(themeId: string): { theme: DocumentTheme | null; fontFamily: string } {
  const theme = themeById(themeId) ?? DOCUMENT_THEMES[0]!;
  if (theme.id === "inline") return { theme: null, fontFamily: theme.bodyFont };
  return { theme, fontFamily: theme.bodyFont };
}

export function chosenThemeId(settings: { theme?: { id?: string } | null }) {
  if (!settings.theme?.id) return "inline";
  return themeById(settings.theme.id)?.id ?? "custom";
}

/** The sheet without one style. Anything based on it, or following it, falls back to the style it was based on. */
export function dropStyle(sheet: readonly ParagraphStyle[], id: string): ParagraphStyle[] {
  const removed = findStyle(sheet, id);
  const fallback = removed?.basedOn && removed.basedOn !== id ? removed.basedOn : "Normal";
  return sheet
    .filter((item) => item.id !== id)
    .map((item) => ({
      ...item,
      basedOn: item.basedOn === id ? fallback : item.basedOn,
      next: item.next === id ? fallback : item.next,
    }));
}

/**
 * Rules for every style. Theme fonts and colors are CSS variables, so they
 * do nothing until a theme sets the variables — an unthemed document keeps
 * the colors in document.css, including dark mode. A hex the style itself
 * states is written outright.
 */
export function styleSheetCss(settings: { styles?: ParagraphStyle[] | null; fontFamily: string; theme?: DocumentTheme | null }): string {
  const sheet = stylesOf(settings);
  const themeOn = Boolean(settings.theme);
  const rules: string[] = [];
  for (const item of sheet) {
    const resolved = resolveStyle(sheet, item.id);
    if (!resolved) continue;
    const builtin = BUILTIN_BY_ID.get(item.id);
    const selector = `.page-content .doc-content [data-style="${cssEscape(item.id)}"]`;
    const decls: string[] = [];
    // Normal's font and color are the page's. Stating them would paint over a quote that contains a normal paragraph.
    const skipInherit = item.id === "Normal";
    if (!skipInherit && resolved.font) {
      if ("theme" in resolved.font) decls.push(`font-family: var(--theme-${resolved.font.theme}-font)`);
      else if (!builtin || !sameFont(builtin.font, resolved.font)) decls.push(`font-family: ${safeFontFamily(resolved.font.family)}`);
      else if (item.id === "Code") decls.push(`font-family: ${safeFontFamily(resolved.font.family)}`);
    }
    if (resolved.size != null) decls.push(`font-size: ${resolved.size}pt`);
    if (!skipInherit && resolved.color) {
      if ("theme" in resolved.color) decls.push(`color: var(--theme-${resolved.color.theme === "text" || resolved.color.theme === "background" ? resolved.color.theme : resolved.color.theme.replace("accent", "accent-")})`);
      else if (themeOn || !builtin || !sameColor(builtin.color, resolved.color)) decls.push(`color: ${resolved.color.hex}`);
    }
    if (resolved.lineHeight != null) decls.push(`line-height: ${resolved.lineHeight}`);
    if (resolved.italic) decls.push("font-style: italic");
    else if (builtin?.italic) decls.push("font-style: normal");
    if (resolved.spaceAfter != null) decls.push(`margin-bottom: ${resolved.spaceAfter}pt`);
    if (decls.length) rules.push(`${selector} { ${decls.join("; ")}; }`);
    if (resolved.spaceBefore != null && resolved.spaceBefore > 0) rules.push(`${selector}:not(:first-child) { margin-top: ${resolved.spaceBefore}pt; }`);
    else if (resolved.spaceBefore === 0) rules.push(`${selector} { margin-top: 0; }`);
  }
  return rules.join("\n");
}

export function themeCssVars(theme: DocumentTheme): Record<string, string> {
  return {
    "--theme-heading-font": theme.headingFont,
    "--theme-body-font": theme.bodyFont,
    "--theme-text": theme.colors.text,
    "--theme-background": theme.colors.background,
    "--theme-accent-1": theme.colors.accent1,
    "--theme-accent-2": theme.colors.accent2,
    "--theme-accent-3": theme.colors.accent3,
    "--theme-accent-4": theme.colors.accent4,
    "--theme-accent-5": theme.colors.accent5,
    "--theme-accent-6": theme.colors.accent6,
    "--paper": theme.colors.background,
    "--paper-text": theme.colors.text,
  };
}

export function stylePreview(resolved: ResolvedStyle, theme: DocumentTheme): { fontFamily?: string; fontSize?: string; color?: string; fontStyle?: "italic" } {
  const fontFamily = resolvedFontFamily(resolved.font, theme) ?? undefined;
  const color = resolvedColorHex(resolved.color, theme) ?? undefined;
  return {
    ...(fontFamily ? { fontFamily } : {}),
    fontSize: `${Math.min(resolved.size ?? 13, 18)}px`,
    ...(color ? { color } : {}),
    ...(resolved.italic ? { fontStyle: "italic" as const } : {}),
  };
}

/** A short key so page breaks are measured again when a style or the theme changes. */
export function styleLayoutKey(settings: { styles?: ParagraphStyle[] | null; theme?: DocumentTheme | null }) {
  if (!settings.styles?.length && !settings.theme) return "";
  const styles = (settings.styles ?? []).map((item) => [item.id, item.basedOn, item.size, item.spaceBefore, item.spaceAfter, item.lineHeight, item.font && ("theme" in item.font ? item.font.theme : item.font.family), item.color && ("theme" in item.color ? item.color.theme : item.color.hex)].join(":")).join(",");
  const theme = settings.theme ? [settings.theme.headingFont, settings.theme.bodyFont, ...Object.values(settings.theme.colors)].join("/") : "";
  return `${theme}|${styles}`;
}

function xmlText(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function firstFontName(family: string) {
  return family.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
}

function fontsXml(font: FontRef | null) {
  if (!font) return "";
  if ("theme" in font) {
    const slot = font.theme === "heading" ? "majorHAnsi" : "minorHAnsi";
    return `<w:rFonts w:asciiTheme="${slot}" w:hAnsiTheme="${slot}" w:cstheme="${slot}"/>`;
  }
  const name = xmlText(firstFontName(font.family));
  return `<w:rFonts w:ascii="${name}" w:hAnsi="${name}" w:cs="${name}"/>`;
}

/** Word's styles part, including styles the document added. */
export function wordStylesXml(input: {
  fontFamily: string;
  fontSize: number;
  lineSpacing: number;
  paragraphSpacing: number;
  fontLines: boolean;
  styles?: ParagraphStyle[] | null;
  theme?: DocumentTheme | null;
}) {
  const theme = activeTheme({ fontFamily: input.fontFamily, theme: input.theme });
  const sheet = stylesOf(input);
  const body = firstFontName(theme.bodyFont);
  const size = Math.round(input.fontSize * 2);
  const line = Math.round(input.lineSpacing * 240);
  const after = Math.round(input.paragraphSpacing * 20);
  const paragraph = sheet.map((item) => wordStyleXml(item, theme, input.fontLines)).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${xmlText(body)}" w:hAnsi="${xmlText(body)}" w:cs="${xmlText(body)}" w:eastAsia="${xmlText(body)}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="${after}" w:line="${line}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${paragraph}<w:style w:type="character" w:styleId="InlineCode"><w:name w:val="HTML Code"/><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/></w:rPr></w:style><w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1155CC"/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableHeading"><w:name w:val="Table Heading"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:pPr><w:spacing w:after="0"/></w:pPr></w:style></w:styles>`;
}

function wordStyleXml(item: ParagraphStyle, theme: DocumentTheme, fontLines: boolean) {
  const role = ROLE[item.id];
  const pPr: string[] = [];
  const rPr: string[] = [];
  if (role?.role === "heading") {
    pPr.push("<w:keepNext/>");
    pPr.push(`<w:outlineLvl w:val="${role.level - 1}"/>`);
  }
  const spacing: string[] = [];
  if (item.spaceBefore != null) spacing.push(`w:before="${Math.round(item.spaceBefore * 20)}"`);
  if (item.spaceAfter != null) spacing.push(`w:after="${Math.round(item.spaceAfter * 20)}"`);
  if (!fontLines && item.lineHeight != null) spacing.push(`w:line="${Math.round(item.lineHeight * 240)}" w:lineRule="auto"`);
  if (spacing.length) pPr.push(`<w:spacing ${spacing.join(" ")}/>`);
  if (item.id === "Quote") pPr.push('<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D0D7DE"/></w:pBdr><w:ind w:left="360"/>');
  if (item.id === "Code") {
    pPr.push('<w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/>');
    if (item.size == null) rPr.push('<w:sz w:val="19"/><w:szCs w:val="19"/>');
  }
  const fonts = fontsXml(item.font);
  if (fonts) rPr.push(fonts);
  if (item.italic) rPr.push("<w:i/>");
  if (item.size != null) rPr.push(`<w:sz w:val="${Math.round(item.size * 2)}"/>`);
  const color = wordColorXml(item.color, theme);
  if (color) rPr.push(color);
  const def = item.id === "Normal" ? ' w:default="1"' : "";
  const based = item.basedOn ? `<w:basedOn w:val="${xmlText(item.basedOn)}"/>` : "";
  const next = item.next ? `<w:next w:val="${xmlText(item.next)}"/>` : "";
  return `<w:style w:type="paragraph"${def} w:styleId="${xmlText(item.id)}"><w:name w:val="${xmlText(item.name)}"/>${based}${next}<w:qFormat/>${pPr.length ? `<w:pPr>${pPr.join("")}</w:pPr>` : ""}${rPr.length ? `<w:rPr>${rPr.join("")}</w:rPr>` : ""}</w:style>`;
}

/**
 * Theme text and accent1 are the paper color until a theme moves them, so
 * those styles omit a color (the page already paints it). Anything else names
 * the theme color and a hex Word can show.
 */
/** DrawingML theme part so Word keeps the heading font, body font and color set. */
export function themeXml(theme: DocumentTheme) {
  const hex = (value: string) => value.replace("#", "").toUpperCase();
  const clr = (tag: string, value: string) => `<a:${tag}><a:srgbClr val="${hex(value)}"/></a:${tag}>`;
  const latin = (family: string) => `<a:latin typeface="${xmlText(firstFontName(family))}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  const fill = "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>";
  const line = (width: number) => `<a:ln w="${width}"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${xmlText(theme.name)}"><a:themeElements><a:clrScheme name="${xmlText(theme.name)}">${clr("dk1", theme.colors.text)}${clr("lt1", theme.colors.background)}${clr("dk2", theme.colors.accent1)}${clr("lt2", "E7E6E6")}${clr("accent1", theme.colors.accent1)}${clr("accent2", theme.colors.accent2)}${clr("accent3", theme.colors.accent3)}${clr("accent4", theme.colors.accent4)}${clr("accent5", theme.colors.accent5)}${clr("accent6", theme.colors.accent6)}${clr("hlink", "1155CC")}${clr("folHlink", "96607D")}</a:clrScheme><a:fontScheme name="${xmlText(theme.name)}"><a:majorFont>${latin(theme.headingFont)}</a:majorFont><a:minorFont>${latin(theme.bodyFont)}</a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

export type WordStyleSnapshot = {
  id: string;
  name: string;
  basedOn: string | null;
  next: string | null;
  /** "major" is the heading font, "minor" the body font. */
  fontTheme: "major" | "minor" | null;
  fontFamily: string | null;
  size: number | null;
  colorTheme: string | null;
  colorHex: string | null;
  spaceBefore: number | null;
  spaceAfter: number | null;
  line: number | null;
  italic: boolean | null;
};

function fontRefEqual(snapshot: WordStyleSnapshot, font: FontRef | null) {
  if (snapshot.fontTheme === "major") return Boolean(font && "theme" in font && font.theme === "heading");
  if (snapshot.fontTheme === "minor") return Boolean(font && "theme" in font && font.theme === "body");
  if (snapshot.fontFamily) return Boolean(font && "family" in font && firstFontName(font.family).toLowerCase() === firstFontName(snapshot.fontFamily).toLowerCase());
  return true;
}

function colorRefEqual(snapshot: WordStyleSnapshot, color: ColorRef | null, theme: DocumentTheme) {
  if (!snapshot.colorTheme && !snapshot.colorHex) {
    if (!color) return true;
    const hex = resolvedColorHex(color, theme);
    return hex == null || hex.toLowerCase() === theme.colors.text.toLowerCase() || hex.toLowerCase() === "#202124";
  }
  if (snapshot.colorTheme && color && "theme" in color) return THEME_COLOR_WORD[color.theme] === snapshot.colorTheme;
  if (snapshot.colorHex && color && "hex" in color) return snapshot.colorHex.toLowerCase() === color.hex.slice(1).toLowerCase();
  return false;
}

/**
 * The document's styles, when a Word file Inline wrote has any that aren't
 * the built-in sheet. Null when the file still has the built-in styles, so a
 * document that never changed them stays unchanged on the way back.
 */
function snapshotDiffers(found: WordStyleSnapshot, options: { fontLines: boolean; theme: DocumentTheme }) {
  const builtin = BUILTIN_BY_ID.get(found.id);
  if (!builtin) return true;
  const spacing = (got: number | null, want: number | null) => got == null || want == null || Math.abs(got - want) < 0.2;
  const lineOk = found.line == null || builtin.lineHeight == null || Math.abs(found.line - builtin.lineHeight) < 0.05 || (options.fontLines && found.line == null);
  const sizeChanged = found.size != null && (builtin.size != null ? Math.abs(found.size - builtin.size) > 0.2 : builtin.id === "Code" ? Math.abs(found.size - 9.5) > 0.2 : true);
  return (
    !fontRefEqual(found, builtin.font) ||
    !colorRefEqual(found, builtin.color, options.theme) ||
    sizeChanged ||
    !spacing(found.spaceBefore, builtin.spaceBefore) ||
    !spacing(found.spaceAfter, builtin.spaceAfter) ||
    !lineOk ||
    Boolean(found.italic) !== Boolean(builtin.italic) ||
    (found.basedOn != null && found.basedOn !== builtin.basedOn) ||
    (found.next != null && found.next !== builtin.next)
  );
}

function styleFromSnapshot(found: WordStyleSnapshot): ParagraphStyle | null {
  const id = safeStyleId(found.id);
  if (!id || id === "TableHeading") return null;
  const builtin = BUILTIN_BY_ID.get(id);
  return {
    id,
    name: found.name || builtin?.name || id,
    basedOn: found.basedOn,
    next: found.next ?? builtin?.next ?? "Normal",
    font: found.fontTheme === "major" ? { theme: "heading" } : found.fontTheme === "minor" ? { theme: "body" } : found.fontFamily ? { family: found.fontFamily } : (builtin?.font ?? null),
    size: found.id === "Code" && found.size != null && Math.abs(found.size - 9.5) < 0.2 ? (builtin?.size ?? null) : (found.size ?? builtin?.size ?? null),
    spaceBefore: found.spaceBefore ?? builtin?.spaceBefore ?? null,
    spaceAfter: found.spaceAfter ?? builtin?.spaceAfter ?? null,
    lineHeight: found.line ?? builtin?.lineHeight ?? null,
    color: found.colorTheme && WORD_THEME_COLOR[found.colorTheme] ? { theme: WORD_THEME_COLOR[found.colorTheme] } : found.colorHex ? { hex: `#${found.colorHex.toLowerCase()}` } : (builtin?.color ?? null),
    italic: found.italic ?? builtin?.italic ?? null,
  };
}

export function stylesFromWord(snapshots: WordStyleSnapshot[], options: { fontLines: boolean; theme: DocumentTheme }): ParagraphStyle[] | null {
  const changed: ParagraphStyle[] = [];
  for (const found of snapshots) {
    if (found.id === "TableHeading" || !snapshotDiffers(found, options)) continue;
    const style = styleFromSnapshot(found);
    if (style) changed.push(style);
  }
  return changed.length ? changed : null;
}

/** A theme part Inline wrote, back into a theme. `fontStack` turns Word's typeface name into a CSS font-family. */
export function parseThemeXml(xml: string, fontStack: (name: string) => string): DocumentTheme | null {
  const name = /<a:theme\b[^>]*\bname="([^"]*)"/.exec(xml)?.[1];
  if (!name) return null;
  const block = (tag: string) => new RegExp(`<a:${tag}\\b[^>]*>([\\s\\S]*?)</a:${tag}>`).exec(xml)?.[1] ?? "";
  const latin = (which: string) => /<a:latin\b[^>]*\btypeface="([^"]*)"/.exec(block(which))?.[1] ?? "";
  const color = (tag: string) => {
    const hex = /<a:srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/.exec(block(tag))?.[1];
    return hex ? `#${hex.toLowerCase()}` : "";
  };
  const heading = latin("majorFont");
  const body = latin("minorFont");
  const text = color("dk1");
  const background = color("lt1");
  if (!heading || !body || !text || !background) return null;
  const accent = (n: number) => color(`accent${n}`) || NEUTRAL[`accent${n}` as ThemeColor];
  return {
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "theme",
    name,
    headingFont: fontStack(heading),
    bodyFont: fontStack(body),
    colors: { text, background, accent1: accent(1), accent2: accent(2), accent3: accent(3), accent4: accent(4), accent5: accent(5), accent6: accent(6) },
  };
}

export function themesLookEqual(a: DocumentTheme, b: DocumentTheme) {
  const font = (family: string) => firstFontName(family).toLowerCase();
  if (font(a.headingFont) !== font(b.headingFont) || font(a.bodyFont) !== font(b.bodyFont)) return false;
  return (Object.keys(a.colors) as ThemeColor[]).every((key) => a.colors[key].toLowerCase() === b.colors[key].toLowerCase());
}

function wordColorXml(color: ColorRef | null, theme: DocumentTheme) {
  if (!color) return "";
  const hex = resolvedColorHex(color, theme);
  if (!hex) return "";
  const bare = hex.slice(1).toUpperCase();
  if ("theme" in color) {
    if ((color.theme === "text" || color.theme === "accent1") && bare === "202124") return "";
    return `<w:color w:val="${bare}" w:themeColor="${THEME_COLOR_WORD[color.theme]}"/>`;
  }
  return `<w:color w:val="${bare}"/>`;
}

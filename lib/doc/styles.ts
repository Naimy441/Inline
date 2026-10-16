/**
 * Named paragraph styles.
 *
 * A style is font, size, spacing and the style of the next paragraph. It can
 * be based on another style. Paragraphs point at a style; they do not copy
 * it. Changing the style changes every paragraph that uses it, and every
 * style that inherits from it. Direct formatting on a paragraph (its own
 * size, spacing, or a font or color on its text) still wins for that
 * paragraph only.
 *
 * Built-in styles name the fonts and colors the page used before document
 * themes: Arial for text, near-black for titles and the first headings, and
 * the greys in app/styles/document.css for the rest. The default text font
 * is not painted over the page, so a document set in another font still
 * sets its headings in that font.
 */

export type FontRef = { family: string };
export type ColorRef = { hex: string };

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

export type StyleRole = "paragraph" | "title" | "subtitle" | "heading" | "quote" | "code";

/** The document's default font. Headings used this too, before a theme could split them. */
export const DEFAULT_STYLE_FONT = "Arial, Helvetica, sans-serif";

/** Page ink. Headings 1 and 2 and the title inherit it, so dark mode can still recolor them. */
const PAPER = "#202124";
/** Heading 3 in app/styles/document.css. */
const HEADING_GREY = "#434343";
/** Subtitle and headings 4–6. */
const MUTED = "#666666";
const QUOTE = "#555555";

/**
 * Colors a saved style might still name as a theme slot. They become the
 * page colors those slots stood for when no theme was chosen.
 */
const LEGACY_THEME_COLOR: Record<string, string> = {
  text: PAPER,
  background: "#ffffff",
  accent1: PAPER,
  accent2: HEADING_GREY,
  accent3: MUTED,
  accent4: "#1a73e8",
  accent5: "#188038",
  accent6: "#c5221f",
};

const style = (partial: ParagraphStyle): ParagraphStyle => partial;

const textFont: FontRef = { family: DEFAULT_STYLE_FONT };
const ink: ColorRef = { hex: PAPER };

/**
 * The block types the page already had, as a real stylesheet. Sizes and
 * spacing match app/styles/document.css so an existing document opens
 * looking as it did.
 */
export const BUILTIN_STYLES: ParagraphStyle[] = [
  style({ id: "Normal", name: "Normal", basedOn: null, next: "Normal", font: textFont, size: null, spaceBefore: null, spaceAfter: null, lineHeight: null, color: ink, italic: null }),
  style({ id: "Title", name: "Title", basedOn: "Normal", next: "Normal", font: textFont, size: 26, spaceBefore: 0, spaceAfter: 3, lineHeight: 1.15, color: ink, italic: null }),
  style({ id: "Subtitle", name: "Subtitle", basedOn: "Normal", next: "Normal", font: textFont, size: 15, spaceBefore: 0, spaceAfter: 16, lineHeight: null, color: { hex: MUTED }, italic: null }),
  style({ id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", font: textFont, size: 20, spaceBefore: 20, spaceAfter: 6, lineHeight: 1.2, color: ink, italic: null }),
  style({ id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", font: textFont, size: 16, spaceBefore: 18, spaceAfter: 6, lineHeight: 1.2, color: ink, italic: null }),
  style({ id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", font: textFont, size: 14, spaceBefore: 16, spaceAfter: 4, lineHeight: 1.2, color: { hex: HEADING_GREY }, italic: null }),
  style({ id: "Heading4", name: "Heading 4", basedOn: "Normal", next: "Normal", font: textFont, size: 12, spaceBefore: 14, spaceAfter: 4, lineHeight: 1.2, color: { hex: MUTED }, italic: null }),
  style({ id: "Heading5", name: "Heading 5", basedOn: "Heading4", next: "Normal", font: null, size: 11, spaceBefore: 12, spaceAfter: 4, lineHeight: 1.2, color: { hex: MUTED }, italic: null }),
  style({ id: "Heading6", name: "Heading 6", basedOn: "Heading4", next: "Normal", font: null, size: 11, spaceBefore: 12, spaceAfter: 4, lineHeight: 1.2, color: { hex: MUTED }, italic: true }),
  style({ id: "Quote", name: "Quote", basedOn: "Normal", next: "Normal", font: null, size: null, spaceBefore: null, spaceAfter: null, lineHeight: null, color: { hex: QUOTE }, italic: null }),
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

function numOrNull(value: unknown, min: number, max: number) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}

function fontRef(value: unknown): FontRef | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { theme?: unknown; family?: unknown };
  // A saved "theme heading" or "theme body" was the document font.
  if (raw.theme === "body" || raw.theme === "heading") return { family: DEFAULT_STYLE_FONT };
  if (typeof raw.family === "string" && safeFontFamily(raw.family)) return { family: safeFontFamily(raw.family) };
  return null;
}

function colorRef(value: unknown): ColorRef | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { theme?: unknown; hex?: unknown };
  if (typeof raw.theme === "string" && raw.theme in LEGACY_THEME_COLOR) return { hex: LEGACY_THEME_COLOR[raw.theme]! };
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

/** True when this is the font the page already uses for body text and headings. */
export function isDefaultStyleFont(family: string) {
  return firstFontName(family).toLowerCase() === "arial";
}

function sameFont(a: FontRef | null, b: FontRef | null) {
  if (!a || !b) return !a && !b;
  return a.family === b.family;
}

function sameColor(a: ColorRef | null, b: ColorRef | null) {
  if (!a || !b) return !a && !b;
  return a.hex.toLowerCase() === b.hex.toLowerCase();
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
 * Rules for every style. A built-in font or color that the page already
 * paints (document.css, including dark mode) is left out, so the page keeps
 * that look. A font or color the style itself changed is written outright.
 */
export function styleSheetCss(settings: { styles?: ParagraphStyle[] | null; fontFamily: string }): string {
  const sheet = stylesOf(settings);
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
      const restatesBuiltin = Boolean(builtin && sameFont(builtin.font, resolved.font));
      if (item.id === "Code" || (!restatesBuiltin && !isDefaultStyleFont(resolved.font.family))) decls.push(`font-family: ${safeFontFamily(resolved.font.family)}`);
    }
    if (resolved.size != null) decls.push(`font-size: ${resolved.size}pt`);
    if (!skipInherit && resolved.color && !(builtin && sameColor(builtin.color, resolved.color))) decls.push(`color: ${resolved.color.hex}`);
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

/** How a style looks in a menu. The default text font follows the document font, and page ink follows the menu. */
export function stylePreview(resolved: ResolvedStyle, documentFont: string): { fontFamily?: string; fontSize?: string; color?: string; fontStyle?: "italic" } {
  const family = resolved.font?.family;
  const fontFamily = family && !isDefaultStyleFont(family) ? family : documentFont;
  const color = resolved.color && resolved.color.hex.toLowerCase() !== PAPER ? resolved.color.hex : undefined;
  return {
    fontFamily,
    fontSize: `${Math.min(resolved.size ?? 13, 18)}px`,
    ...(color ? { color } : {}),
    ...(resolved.italic ? { fontStyle: "italic" as const } : {}),
  };
}

/** A short key so page breaks are measured again when a style changes. */
export function styleLayoutKey(settings: { styles?: ParagraphStyle[] | null }) {
  if (!settings.styles?.length) return "";
  return settings.styles.map((item) => [item.id, item.basedOn, item.size, item.spaceBefore, item.spaceAfter, item.lineHeight, item.font?.family ?? "", item.color?.hex ?? ""].join(":")).join(",");
}

function xmlText(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function firstFontName(family: string) {
  return family.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
}

function fontsXml(font: FontRef | null) {
  if (!font || isDefaultStyleFont(font.family)) return "";
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
}) {
  const sheet = stylesOf(input);
  const body = firstFontName(input.fontFamily);
  const size = Math.round(input.fontSize * 2);
  const line = Math.round(input.lineSpacing * 240);
  const after = Math.round(input.paragraphSpacing * 20);
  const paragraph = sheet.map((item) => wordStyleXml(item, input.fontLines)).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${xmlText(body)}" w:hAnsi="${xmlText(body)}" w:cs="${xmlText(body)}" w:eastAsia="${xmlText(body)}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="${after}" w:line="${line}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${paragraph}<w:style w:type="character" w:styleId="InlineCode"><w:name w:val="HTML Code"/><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/></w:rPr></w:style><w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1155CC"/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableHeading"><w:name w:val="Table Heading"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:pPr><w:spacing w:after="0"/></w:pPr></w:style></w:styles>`;
}

function wordStyleXml(item: ParagraphStyle, fontLines: boolean) {
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
  const color = wordColorXml(item.color);
  if (color) rPr.push(color);
  const def = item.id === "Normal" ? ' w:default="1"' : "";
  const based = item.basedOn ? `<w:basedOn w:val="${xmlText(item.basedOn)}"/>` : "";
  const next = item.next ? `<w:next w:val="${xmlText(item.next)}"/>` : "";
  return `<w:style w:type="paragraph"${def} w:styleId="${xmlText(item.id)}"><w:name w:val="${xmlText(item.name)}"/>${based}${next}<w:qFormat/>${pPr.length ? `<w:pPr>${pPr.join("")}</w:pPr>` : ""}${rPr.length ? `<w:rPr>${rPr.join("")}</w:rPr>` : ""}</w:style>`;
}

export type WordStyleSnapshot = {
  id: string;
  name: string;
  basedOn: string | null;
  next: string | null;
  fontFamily: string | null;
  size: number | null;
  colorHex: string | null;
  spaceBefore: number | null;
  spaceAfter: number | null;
  line: number | null;
  italic: boolean | null;
};

function fontRefEqual(snapshot: WordStyleSnapshot, font: FontRef | null) {
  if (!snapshot.fontFamily) return true;
  return Boolean(font && firstFontName(font.family).toLowerCase() === firstFontName(snapshot.fontFamily).toLowerCase());
}

function colorRefEqual(snapshot: WordStyleSnapshot, color: ColorRef | null) {
  if (!snapshot.colorHex) return !color || color.hex.toLowerCase() === PAPER;
  if (!color) return false;
  return snapshot.colorHex.toLowerCase() === color.hex.slice(1).toLowerCase();
}

/**
 * The document's styles, when a Word file Inline wrote has any that aren't
 * the built-in sheet. Null when the file still has the built-in styles, so a
 * document that never changed them stays unchanged on the way back.
 */
function snapshotDiffers(found: WordStyleSnapshot, options: { fontLines: boolean }) {
  const builtin = BUILTIN_BY_ID.get(found.id);
  if (!builtin) return true;
  const spacing = (got: number | null, want: number | null) => got == null || want == null || Math.abs(got - want) < 0.2;
  const lineOk = found.line == null || builtin.lineHeight == null || Math.abs(found.line - builtin.lineHeight) < 0.05 || (options.fontLines && found.line == null);
  const sizeChanged = found.size != null && (builtin.size != null ? Math.abs(found.size - builtin.size) > 0.2 : builtin.id === "Code" ? Math.abs(found.size - 9.5) > 0.2 : true);
  return (
    !fontRefEqual(found, builtin.font) ||
    !colorRefEqual(found, builtin.color) ||
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
    font: found.fontFamily ? { family: found.fontFamily } : (builtin?.font ?? null),
    size: found.id === "Code" && found.size != null && Math.abs(found.size - 9.5) < 0.2 ? (builtin?.size ?? null) : (found.size ?? builtin?.size ?? null),
    spaceBefore: found.spaceBefore ?? builtin?.spaceBefore ?? null,
    spaceAfter: found.spaceAfter ?? builtin?.spaceAfter ?? null,
    lineHeight: found.line ?? builtin?.lineHeight ?? null,
    color: found.colorHex ? { hex: `#${found.colorHex.toLowerCase()}` } : (builtin?.color ?? null),
    italic: found.italic ?? builtin?.italic ?? null,
  };
}

export function stylesFromWord(snapshots: WordStyleSnapshot[], options: { fontLines: boolean }): ParagraphStyle[] | null {
  const changed: ParagraphStyle[] = [];
  for (const found of snapshots) {
    if (found.id === "TableHeading" || !snapshotDiffers(found, options)) continue;
    const style = styleFromSnapshot(found);
    if (style) changed.push(style);
  }
  return changed.length ? changed : null;
}

/** Page ink is left off so Word uses the document color. Anything else is a plain hex. */
function wordColorXml(color: ColorRef | null) {
  if (!color) return "";
  const bare = color.hex.slice(1).toUpperCase();
  if (bare === "202124") return "";
  return `<w:color w:val="${bare}"/>`;
}

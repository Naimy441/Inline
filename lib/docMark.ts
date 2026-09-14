export const DOC_MARK_COLORS = [
  "#e879f9",
] as const;

export const DOC_MARK_STORAGE_KEY = "inline-doc-mark-color";
export const DOC_MARK_FALLBACK = "#e879f9";

export function isDocMarkColor(value: string | null | undefined): value is (typeof DOC_MARK_COLORS)[number] {
  return Boolean(value && (DOC_MARK_COLORS as readonly string[]).includes(value));
}

export function pickDocMarkColor() {
  return DOC_MARK_COLORS[Math.floor(Math.random() * DOC_MARK_COLORS.length)];
}

/** Inline boot script: assign a mark color once per document and keep it. */
export const docMarkBootScript = `try{var k=${JSON.stringify(DOC_MARK_STORAGE_KEY)};var colors=${JSON.stringify(DOC_MARK_COLORS)};var c=localStorage.getItem(k);if(!c||colors.indexOf(c)<0){c=colors[Math.floor(Math.random()*colors.length)];localStorage.setItem(k,c)}document.documentElement.style.setProperty('--doc-mark',c)}catch(e){}`;

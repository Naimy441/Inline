import type { PdfImage, PdfPage, RGB } from "@/lib/pdf/pdfWriter";

/** The app's light or dark appearance (the page the user is looking at), not a document's fonts or colors. */
export type PageAppearance = "light" | "dark";

/** Paper colors from app/styles/base.css (--paper). */
export const APPEARANCE_PAPER: Record<PageAppearance, string> = {
  light: "#ffffff",
  dark: "#262624",
};

/** Dark appearance text (--paper-text). The print model stores default ink as black. */
const DARK_INK: RGB = [0xe6 / 255, 0xe4 / 255, 0xdf / 255];

export function pageAppearance(value: unknown): PageAppearance | null {
  return value === "light" || value === "dark" ? value : null;
}

function isDefaultInk(color: RGB) {
  return color.every((channel) => channel < 0.04);
}

/**
 * The print model draws default ink in black and leaves the paper clear.
 * A dark screenshot paints that ink in the dark page's text color. Other
 * colors stay as they were read. Light returns the same page.
 */
export function pageForAppearance(page: PdfPage, appearance: PageAppearance): PdfPage {
  if (appearance === "light") return page;
  return {
    ...page,
    items: page.items.map((item) => {
      if ((item.kind === "text" || item.kind === "line") && isDefaultInk(item.color)) return { ...item, color: DARK_INK };
      if (item.kind === "rect" && isDefaultInk(item.fill)) return { ...item, fill: DARK_INK };
      return item;
    }),
  };
}

/**
 * A page ready to rasterize, plus equation pictures to draw afterwards.
 * Those are black ink on a white rectangle. On a dark page they are left
 * out of the PDF and composited so the white doesn't cover the paper.
 */
export function screenshotPage(page: PdfPage, appearance: PageAppearance): { page: PdfPage; ink: PdfImage[] } {
  const themed = pageForAppearance(page, appearance);
  if (appearance === "light") return { page: themed, ink: [] };
  const ink: PdfImage[] = [];
  const items = themed.items.filter((item) => {
    if (item.kind === "image" && item.ink) {
      ink.push(item);
      return false;
    }
    return true;
  });
  return { page: items.length === themed.items.length ? themed : { ...themed, items }, ink };
}

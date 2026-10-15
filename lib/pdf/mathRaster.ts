// Pictures of the typeset equations, for the PDF and the home page cover.
// The PDF writer only has the standard fonts, which can't draw KaTeX's
// symbols, so each equation is drawn by the browser itself (an SVG
// foreignObject with KaTeX's styles and fonts inlined) onto a canvas.

import type { Box } from "@/lib/pdf/pageSnapshot";

/** A picture of an equation; one that wraps onto more lines has a picture per line in `parts`. */
export type MathRaster = { jpeg: Uint8Array; width: number; height: number; box: Box; parts?: MathRaster[] };

const SCALE = 3;
const fontCache = new Map<string, Promise<string>>();
let rulesCache: { rules: string; fonts: Array<{ family: string; css: string; urls: string[] }> } | null = null;

/** KaTeX's style rules and font faces from the page's stylesheets. */
function katexRules() {
  if (rulesCache) return rulesCache;
  const rules: string[] = [];
  const fonts: Array<{ family: string; css: string; urls: string[] }> = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(list)) {
      if (rule instanceof CSSFontFaceRule) {
        const family = rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim();
        if (!family.startsWith("KaTeX")) continue;
        const src = rule.style.getPropertyValue("src");
        const first = src.match(/url\(\s*["']?([^"')]+)["']?\s*\)/);
        if (!first) continue;
        const url = new URL(first[1]!, sheet.href ?? location.href).href;
        fonts.push({ family, css: rule.cssText, urls: [url] });
      } else if (rule.cssText.includes("katex")) {
        rules.push(rule.cssText);
      }
    }
  }
  rulesCache = { rules: rules.join("\n"), fonts };
  return rulesCache;
}

function fontData(url: string) {
  let pending = fontCache.get(url);
  if (!pending) {
    pending = fetch(url)
      .then((response) => response.blob())
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          }),
      );
    pending.catch(() => fontCache.delete(url));
    fontCache.set(url, pending);
  }
  return pending;
}

/** The font faces the equation uses, with the font files inlined (an SVG image can't load files). */
async function fontFaces(families: Set<string>) {
  const { fonts } = katexRules();
  const faces = await Promise.all(
    fonts
      .filter((font) => families.has(font.family))
      .map(async (font) => {
        const data = await fontData(font.urls[0]!).catch(() => null);
        if (!data) return "";
        const format = /\.woff2(\?|$)/.test(font.urls[0]!) ? "woff2" : /\.woff(\?|$)/.test(font.urls[0]!) ? "woff" : "truetype";
        return font.css.replace(/src\s*:[^;}]+/, `src: url("${data}") format("${format}")`);
      }),
  );
  return faces.join("\n");
}

function load(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't draw the equation."));
    img.src = src;
  });
}

function toJpeg(canvas: HTMLCanvasElement) {
  const url = canvas.toDataURL("image/jpeg", 0.92);
  const binary = atob(url.slice(url.indexOf(",") + 1));
  const jpeg = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) jpeg[i] = binary.charCodeAt(i);
  return jpeg;
}

/**
 * Where hidden copies of an equation are laid out to be measured: beside the
 * editor rather than in it (the editor watches its own DOM), in the same zoom.
 */
function scratchHost(katexEl: HTMLElement) {
  return katexEl.closest<HTMLElement>(".page-stack") ?? document.body;
}

/** The extent of what an equation draws, from its parts' boxes (KaTeX's stretched SVGs count only for height: they are drawn wide and clipped). */
function inkExtent(katexEl: HTMLElement) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const part of [katexEl, ...Array.from(katexEl.querySelectorAll<Element>(".katex-html *"))]) {
    const rect = part.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
    if (part instanceof SVGElement || part.tagName === "svg") continue;
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
  }
  return Number.isFinite(left) && Number.isFinite(top) ? { left, top, right, bottom } : null;
}

async function rasterize(katexEl: HTMLElement): Promise<MathRaster | null> {
  const outer = katexEl.getBoundingClientRect();
  if (!katexEl.offsetWidth || !katexEl.offsetHeight || !outer.width) return null;
  const scale = outer.width / katexEl.offsetWidth;
  const ink = inkExtent(katexEl);
  if (!ink) return null;
  const families = new Set<string>();
  for (const el of [katexEl, ...Array.from(katexEl.querySelectorAll<HTMLElement>(".katex-html *"))]) {
    for (const family of getComputedStyle(el).fontFamily.split(",")) families.add(family.replace(/["']/g, "").trim());
  }
  const style = getComputedStyle(katexEl);
  const clone = katexEl.cloneNode(true) as HTMLElement;
  clone.style.fontSize = style.fontSize;
  clone.style.color = "#000";
  clone.style.display = style.display;
  clone.style.textAlign = style.textAlign;
  clone.style.width = `${katexEl.offsetWidth}px`;
  clone.style.margin = "0";
  // A line of a wrapped equation is drawn from a hidden, positioned copy (rasterizeLines).
  clone.style.visibility = "visible";
  clone.style.position = "static";
  // The picture is laid out as the page lays the line out (its size and line height), first here, hidden, to
  // measure where the ink lands in it: a tall equation pushes its line down, so it can't be worked out.
  const wrapperStyle = `margin:0;padding:0;font-size:${style.fontSize};line-height:${style.lineHeight};white-space:nowrap`;
  const probe = document.createElement("div");
  probe.setAttribute("style", `${wrapperStyle};position:absolute;left:-100000px;top:0;visibility:hidden`);
  const probeClone = clone.cloneNode(true) as HTMLElement;
  probeClone.style.visibility = "hidden";
  probe.append(probeClone);
  scratchHost(katexEl).append(probe);
  let measured: { box: DOMRect; ink: NonNullable<ReturnType<typeof inkExtent>>; outer: DOMRect } | null = null;
  try {
    const at = inkExtent(probeClone);
    if (at) measured = { box: probe.getBoundingClientRect(), ink: at, outer: probeClone.getBoundingClientRect() };
  } finally {
    probe.remove();
  }
  if (!measured) return null;
  // The probe sits in the page's zoom, like the equation: its measures are scaled back to layout pixels.
  const unscale = (value: number) => value / scale;
  const width = Math.ceil(unscale(measured.box.width));
  const fullHeight = Math.ceil(unscale(Math.max(measured.box.height, measured.ink.bottom - measured.box.top))) + 1;
  const markup = new XMLSerializer().serializeToString(clone);
  const css = `${katexRules().rules}\n${await fontFaces(families)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${fullHeight}"><foreignObject x="0" y="0" width="${width}" height="${fullHeight}"><div xmlns="http://www.w3.org/1999/xhtml" style="${wrapperStyle}"><style>${css.replace(/<\/style/gi, "")}</style>${markup}</div></foreignObject></svg>`;
  const img = await load(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  // Crop to the ink, in layout pixels.
  const cropX = unscale(measured.ink.left - measured.box.left);
  const cropY = unscale(measured.ink.top - measured.box.top);
  const cropW = Math.max(1, unscale(measured.ink.right - measured.ink.left));
  const cropH = Math.max(1, unscale(measured.ink.bottom - measured.ink.top));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(cropW * SCALE);
  canvas.height = Math.ceil(cropH * SCALE);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
  // Where the ink is on the page: the same offset from the equation's own box as in the probe.
  const left = outer.left + (measured.ink.left - measured.outer.left);
  const top = outer.top + (measured.ink.top - measured.outer.top);
  return { jpeg: toJpeg(canvas), width: canvas.width, height: canvas.height, box: { left, top, width: measured.ink.right - measured.ink.left, height: measured.ink.bottom - measured.ink.top } };
}

/**
 * An inline equation broken across lines (KaTeX lets one break after a
 * relation, as TeX does) is drawn a line at a time: one picture of it all
 * would span both lines and the whole text width, covering the words beside
 * it. Each line's pieces are copied into a hidden equation of their own,
 * drawn, and placed where they are. Null when it is on one line.
 */
async function rasterizeLines(katexEl: HTMLElement): Promise<MathRaster | null> {
  const html = katexEl.querySelector<HTMLElement>(":scope > .katex-html");
  if (!html || !katexEl.parentElement) return null;
  const groups: Array<{ top: number; parts: HTMLElement[] }> = [];
  for (const part of Array.from(html.children) as HTMLElement[]) {
    const rect = part.getBoundingClientRect();
    if (!rect.width && !rect.height) continue;
    const group = groups.find((item) => Math.abs(item.top - rect.top) < Math.max(2, rect.height / 2));
    if (group) group.parts.push(part);
    else groups.push({ top: rect.top, parts: [part] });
  }
  if (groups.length < 2) return null;
  const parts: MathRaster[] = [];
  for (const group of groups) {
    const copy = katexEl.cloneNode(false) as HTMLElement;
    const inner = html.cloneNode(false) as HTMLElement;
    for (const part of group.parts) inner.appendChild(part.cloneNode(true));
    copy.appendChild(inner);
    copy.style.position = "absolute";
    copy.style.left = "-100000px";
    copy.style.top = "0";
    copy.style.visibility = "hidden";
    copy.style.whiteSpace = "nowrap";
    copy.style.fontSize = getComputedStyle(katexEl).fontSize;
    copy.style.lineHeight = getComputedStyle(katexEl).lineHeight;
    scratchHost(katexEl).appendChild(copy);
    try {
      const raster = await rasterize(copy);
      if (!raster) continue;
      // Move the picture from the hidden copy to where this line's pieces are.
      const from = (inner.firstElementChild as HTMLElement).getBoundingClientRect();
      const to = group.parts[0]!.getBoundingClientRect();
      parts.push({ ...raster, box: { ...raster.box, left: raster.box.left + to.left - from.left, top: raster.box.top + to.top - from.top } });
    } finally {
      copy.remove();
    }
  }
  if (!parts.length) return null;
  const left = Math.min(...parts.map((part) => part.box.left));
  const top = Math.min(...parts.map((part) => part.box.top));
  const right = Math.max(...parts.map((part) => part.box.left + part.box.width));
  const bottom = Math.max(...parts.map((part) => part.box.top + part.box.height));
  return { ...parts[0]!, box: { left, top, width: right - left, height: bottom - top }, parts };
}

/**
 * A picture of every typeset equation under `root`, keyed by its .katex
 * element. Equations that can't be drawn (a browser that won't read back an
 * SVG with HTML in it) are left out, and the snapshot falls back to their text.
 */
export async function rasterizeMath(root: HTMLElement): Promise<Map<Element, MathRaster>> {
  const out = new Map<Element, MathRaster>();
  const equations = Array.from(root.querySelectorAll<HTMLElement>(".math-render .katex"));
  if (!equations.length) return out;
  await document.fonts?.ready;
  for (const el of equations) {
    try {
      const raster = (await rasterizeLines(el)) ?? (await rasterize(el));
      if (raster) out.set(el, raster);
    } catch {
      // Leave it to the text fallback.
    }
  }
  return out;
}

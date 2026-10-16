import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings } from "@/lib/doc/settings";
import { BUILTIN_STYLES, normalizeStyle, resolveStyle, styleSheetCss, stylesFromWord, styleIdFromName, stylesToStore } from "@/lib/doc/styles";

describe("named styles", () => {
  it("a new style takes its id from the name when that id is free", () => {
    const taken = new Set(BUILTIN_STYLES.map((item) => item.id));
    assert.equal(styleIdFromName("Callout", taken), "Callout");
    assert.equal(styleIdFromName("My style", taken), "Mystyle");
    assert.equal(styleIdFromName("Normal", taken), null);
    assert.equal(styleIdFromName("Heading 1", taken), null);
  });

  it("a style based on another follows a change to the base, and its own value wins", () => {
    const heading = { ...BUILTIN_STYLES.find((item) => item.id === "Heading1")!, size: 30 };
    const big = { id: "Big", name: "Big", basedOn: "Heading1", next: "Normal", font: null, size: null, spaceBefore: null, spaceAfter: null, lineHeight: null, color: null, italic: null };
    assert.equal(resolveStyle([heading, big], "Big")!.size, 30);
    assert.equal(resolveStyle([{ ...heading, size: 36 }, big], "Big")!.size, 36);
    assert.equal(resolveStyle([{ ...heading, size: 36 }, { ...big, size: 14 }], "Big")!.size, 14);
  });

  it("built-in styles name real fonts and colors, and the page stylesheet does not depend on a theme", () => {
    const heading = BUILTIN_STYLES.find((item) => item.id === "Heading1")!;
    const subtitle = BUILTIN_STYLES.find((item) => item.id === "Subtitle")!;
    const quote = BUILTIN_STYLES.find((item) => item.id === "Quote")!;
    assert.equal(heading.font && "family" in heading.font ? heading.font.family : null, "Arial, Helvetica, sans-serif");
    assert.equal(heading.color && "hex" in heading.color ? heading.color.hex : null, "#202124");
    assert.equal(subtitle.color && "hex" in subtitle.color ? subtitle.color.hex : null, "#666666");
    assert.equal(quote.color && "hex" in quote.color ? quote.color.hex : null, "#555555");
    const css = styleSheetCss({ fontFamily: "Arial, Helvetica, sans-serif" });
    assert.doesNotMatch(css, /--theme-/);
    assert.doesNotMatch(css, /\[data-style="Heading1"\][^{]*\{[^}]*color:/);
    assert.doesNotMatch(css, /\[data-style="Quote"\][^{]*\{[^}]*color:/);
    assert.doesNotMatch(css, /\[data-style="Normal"\][^{]*\{[^}]*font-family:/);
    assert.match(css, /\[data-style="Code"\][^{]*\{[^}]*font-family: "Roboto Mono"/);
    const callout = { id: "Callout", name: "Callout", basedOn: "Normal", next: "Normal", font: { family: "Georgia, serif" }, size: 18, spaceBefore: null, spaceAfter: null, lineHeight: null, color: { hex: "#1a73e8" }, italic: null };
    const styled = styleSheetCss({ fontFamily: "Arial, Helvetica, sans-serif", styles: [callout] });
    assert.match(styled, /\[data-style="Callout"\][^{]*\{[^}]*font-family: Georgia, serif/);
    assert.match(styled, /\[data-style="Callout"\][^{]*\{[^}]*color: #1a73e8/);
  });

  it("a saved theme font or theme color becomes the font and color the page used", () => {
    const style = normalizeStyle({ id: "Callout", name: "Callout", font: { theme: "heading" }, color: { theme: "accent2" } });
    assert.deepEqual(style?.font, { family: "Arial, Helvetica, sans-serif" });
    assert.deepEqual(style?.color, { hex: "#434343" });
  });

  it("Word's copy of the built-in styles is not stored again, and an added style is", () => {
    const normal = { id: "Normal", name: "Normal", basedOn: null, next: "Normal", fontFamily: null, size: null, colorHex: null, spaceBefore: null, spaceAfter: null, line: null, italic: null };
    assert.equal(stylesFromWord([normal], { fontLines: false }), null);
    const adopted = stylesFromWord(
      [normal, { id: "Callout", name: "Callout", basedOn: "Normal", next: "Normal", fontFamily: "Georgia", size: 18, colorHex: "1A73E8", spaceBefore: 0, spaceAfter: 12, line: 1.4, italic: null }],
      { fontLines: false },
    );
    assert.deepEqual(
      adopted?.map((item) => item.id),
      ["Callout"],
    );
    assert.deepEqual(adopted?.[0]?.font, { family: "Georgia" });
    assert.deepEqual(adopted?.[0]?.color, { hex: "#1a73e8" });
    assert.equal(adopted?.[0]?.size, 18);
  });

  it("settings stay free of styles until one is set", () => {
    const settings = normalizeSettings({ theme: { id: "classic", name: "Classic", headingFont: "Georgia, serif", bodyFont: "Times New Roman", colors: {} } });
    assert.equal("styles" in settings, false);
    assert.equal("theme" in settings, false);
    assert.equal(settings.fontFamily, DEFAULT_SETTINGS.fontFamily);
    assert.equal(stylesToStore(BUILTIN_STYLES), undefined);
  });
});

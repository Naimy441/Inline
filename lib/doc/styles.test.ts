import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings } from "@/lib/doc/settings";
import {
  BUILTIN_STYLES,
  DOCUMENT_THEMES,
  activeTheme,
  parseThemeXml,
  resolveStyle,
  styleSheetCss,
  stylesFromWord,
  styleIdFromName,
  stylesToStore,
  themeCssVars,
  themeXml,
  themesLookEqual,
} from "@/lib/doc/styles";

describe("named styles and themes", () => {
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

  it("theme fonts and colors stay variables until a theme is chosen", () => {
    const css = styleSheetCss({ fontFamily: "Arial, Helvetica, sans-serif" });
    assert.match(css, /\[data-style="Heading1"\][^{]*\{[^}]*color: var\(--theme-accent-1\)/);
    assert.doesNotMatch(css, /\[data-style="Quote"\][^{]*\{[^}]*color:/);
    assert.doesNotMatch(css, /\[data-style="Normal"\][^{]*\{[^}]*font-family:/);
    const classic = DOCUMENT_THEMES.find((item) => item.id === "classic")!;
    assert.match(styleSheetCss({ fontFamily: classic.bodyFont, theme: classic }), /\[data-style="Quote"\][^{]*\{[^}]*color: #555555/);
    assert.equal(themeCssVars(classic)["--theme-heading-font"], classic.headingFont);
    assert.equal(themeCssVars(classic)["--paper"], classic.colors.background);
  });

  it("a theme part reads back as the same fonts and colors", () => {
    const classic = DOCUMENT_THEMES.find((item) => item.id === "classic")!;
    const parsed = parseThemeXml(themeXml(classic), (name) => name);
    assert.ok(parsed);
    assert.equal(themesLookEqual(parsed!, { ...classic, headingFont: "Georgia", bodyFont: "Times New Roman" }), true);
  });

  it("Word's copy of the built-in styles is not stored again, and an added style is", () => {
    const theme = activeTheme({ fontFamily: "Arial, Helvetica, sans-serif" });
    const normal = { id: "Normal", name: "Normal", basedOn: null, next: "Normal", fontTheme: "minor" as const, fontFamily: null, size: null, colorTheme: null, colorHex: null, spaceBefore: null, spaceAfter: null, line: null, italic: null };
    assert.equal(stylesFromWord([normal], { fontLines: false, theme }), null);
    const adopted = stylesFromWord(
      [normal, { id: "Callout", name: "Callout", basedOn: "Normal", next: "Normal", fontTheme: "major" as const, fontFamily: null, size: 18, colorTheme: "accent1", colorHex: "1E3A5F", spaceBefore: 0, spaceAfter: 12, line: 1.4, italic: null }],
      { fontLines: false, theme },
    );
    assert.deepEqual(
      adopted?.map((item) => item.id),
      ["Callout"],
    );
    assert.equal(adopted?.[0]?.font && "theme" in adopted[0].font ? adopted[0].font.theme : null, "heading");
    assert.equal(adopted?.[0]?.size, 18);
  });

  it("settings stay free of styles and a theme until one is set", () => {
    const settings = normalizeSettings({});
    assert.equal("styles" in settings, false);
    assert.equal("theme" in settings, false);
    assert.equal(settings.fontFamily, DEFAULT_SETTINGS.fontFamily);
    assert.equal(stylesToStore(BUILTIN_STYLES), undefined);
  });
});

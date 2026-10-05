import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanTitle, DEFAULT_SETTINGS, fillHeaderTokens, normalizeSettings, pageSize, patchSettings, titleFromText } from "./settings";

describe("document settings", () => {
  it("falls back to defaults for missing or malformed input", () => {
    assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(normalizeSettings("nonsense"), DEFAULT_SETTINGS);
    const settings = normalizeSettings({ fontSize: "huge", pageSetup: { paperSize: "napkin", margins: { top: -4 } } });
    assert.equal(settings.fontSize, DEFAULT_SETTINGS.fontSize);
    assert.equal(settings.pageSetup.paperSize, DEFAULT_SETTINGS.pageSetup.paperSize);
    assert.ok(settings.pageSetup.margins.top >= 0, "margins are never negative");
  });

  it("keeps valid values", () => {
    const settings = normalizeSettings({ fontSize: 14, lineSpacing: 2, pageSetup: { paperSize: "a4", orientation: "landscape" } });
    assert.equal(settings.fontSize, 14);
    assert.equal(settings.lineSpacing, 2);
    assert.equal(settings.pageSetup.paperSize, "a4");
    assert.equal(settings.pageSetup.orientation, "landscape");
  });

  it("keeps font stacks but strips anything that could break out of a style sheet", () => {
    assert.equal(normalizeSettings({ fontFamily: '"EB Garamond", serif' }).fontFamily, '"EB Garamond", serif');
    assert.equal(normalizeSettings({ fontFamily: "x; } </style><script>" }).fontFamily, "x  /stylescript");
    assert.equal(normalizeSettings({ fontFamily: ";;" }).fontFamily, DEFAULT_SETTINGS.fontFamily);
  });

  it("patches nested groups without dropping their other fields", () => {
    const patched = patchSettings(DEFAULT_SETTINGS, { headerFooter: { header: "Draft" }, pageNumbers: { enabled: true } });
    assert.equal(patched.headerFooter.header, "Draft");
    assert.equal(patched.headerFooter.footerAlign, DEFAULT_SETTINGS.headerFooter.footerAlign);
    assert.equal(patched.pageNumbers.enabled, true);
    assert.equal(patched.pageNumbers.position, DEFAULT_SETTINGS.pageNumbers.position);
  });

  it("swaps width and height in landscape", () => {
    assert.deepEqual(pageSize({ ...DEFAULT_SETTINGS.pageSetup, paperSize: "letter", orientation: "portrait" }), { width: 8.5, height: 11 });
    assert.deepEqual(pageSize({ ...DEFAULT_SETTINGS.pageSetup, paperSize: "letter", orientation: "landscape" }), { width: 11, height: 8.5 });
  });
});

describe("titles", () => {
  it("cleans whitespace and never returns an empty title", () => {
    assert.equal(cleanTitle("  Quarterly   report \n"), "Quarterly report");
    assert.equal(cleanTitle(""), "Untitled document");
    assert.equal(cleanTitle(42), "Untitled document");
    assert.equal(cleanTitle("x".repeat(500)).length, 200);
  });

  it("derives a title from the first line, cut at a word boundary", () => {
    assert.equal(titleFromText("   "), null);
    assert.equal(titleFromText("Meeting notes"), "Meeting notes");
    const long = "This opening sentence keeps going well past the point where a title would still be readable in a list";
    const title = titleFromText(long)!;
    assert.ok(title.endsWith("…"));
    assert.ok(title.length <= 81);
    assert.ok(long.startsWith(title.slice(0, -1)), "the cut lands between words");
  });
});

describe("header tokens", () => {
  it("fills page, pages, title and date", () => {
    const text = fillHeaderTokens("{title} · Page {page} of {PAGES} · {date}", { page: 2, pages: 5, title: "Plan", date: new Date(2026, 9, 5) });
    assert.match(text, /^Plan · Page 2 of 5 · /);
    assert.match(text, /2026/);
  });
});

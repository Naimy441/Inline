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

  it("derives a short title from the first line while it is still being typed", () => {
    assert.equal(titleFromText("   "), null);
    assert.equal(titleFromText("Meeting notes"), "Meeting notes");
    assert.equal(titleFromText("Meet"), "Meet");

    const sentence = "This opening sentence keeps going well past the point where a title would still be readable in a list";
    let settled = "";
    for (let i = 1; i <= sentence.length; i += 1) {
      const title = titleFromText(sentence.slice(0, i))!;
      assert.ok(title.length <= 49, title);
      const stem = title.endsWith("…") ? title.slice(0, -1) : title;
      assert.ok(sentence.startsWith(stem), title);
      if (title.endsWith("…")) {
        const next = sentence[stem.length];
        assert.ok(next === undefined || next === " " || ",;:.-".includes(next), `cut inside a word: ${title}`);
        if (settled) assert.equal(title, settled, "the shortened title stays put as typing continues");
        else settled = title;
      } else if (settled) {
        assert.fail(`title grew again after it was shortened: ${title}`);
      }
    }
    assert.equal(settled, "This opening sentence keeps going well past the…");

    // A short word followed by a long token is cut at the word, not through the token.
    assert.equal(titleFromText(`Hi ${"x".repeat(80)}`), "Hi…");
    assert.equal(titleFromText("x".repeat(60)), `${"x".repeat(48)}…`);
  });
});

describe("header tokens", () => {
  it("fills page, pages, title and date", () => {
    const text = fillHeaderTokens("{title} · Page {page} of {PAGES} · {date}", { page: 2, pages: 5, title: "Plan", date: new Date(2026, 9, 5) });
    assert.match(text, /^Plan · Page 2 of 5 · /);
    assert.match(text, /2026/);
  });
});

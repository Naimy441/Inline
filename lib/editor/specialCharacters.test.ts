import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";
import { createCatalog, formatCodePoint, hangulName, parseCodePoint, type CharacterCatalog, type CharacterSource } from "./specialCharacters";

const catalog: CharacterCatalog = createCatalog(JSON.parse(readFileSync(new URL("../../public/unicode/catalog.json", import.meta.url), "utf8")));

function contains(source: CharacterSource, cp: number) {
  let lo = 0;
  let hi = source.count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = source.at(mid);
    if (value === cp) return true;
    if (value < cp) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

function block(categoryName: string, blockName: string) {
  const category = catalog.categories.find((item) => item.name === categoryName);
  assert.ok(category, categoryName);
  const found = category.blocks.find((item) => item.name === blockName);
  assert.ok(found, blockName);
  return found;
}

describe("special characters", () => {
  it("lists every named Unicode 18.0.0 character, once, in Google Docs categories", () => {
    assert.equal(catalog.version, "18.0.0");
    assert.equal(catalog.count, 172808);
    assert.deepEqual(
      catalog.categories.map((category) => category.name),
      [
        "Symbol",
        "Punctuation",
        "Number",
        "Format & Whitespace",
        "Modifier",
        "Latin",
        "Other European Scripts",
        "American Scripts",
        "African Scripts",
        "Middle Eastern Scripts",
        "South Asian Scripts",
        "Southeast Asian Scripts",
        "Hangul",
        "Other East Asian Scripts",
        "Han",
        "Other",
      ],
    );
    const seen = new Uint8Array(0x110000);
    let total = 0;
    for (const category of catalog.categories) {
      assert.ok(category.blocks.length > 0, category.name);
      let previous = -1;
      assert.equal(category.source.count, category.blocks.reduce((sum, item) => sum + item.count, 0), category.name);
      for (let i = 0; i < category.source.count; i += 1) {
        const cp = category.source.at(i);
        assert.ok(cp > previous, `${category.name} ${formatCodePoint(cp)}`);
        assert.equal(seen[cp], 0, formatCodePoint(cp));
        seen[cp] = 1;
        previous = cp;
        total += 1;
      }
      for (const item of category.blocks) {
        assert.ok(item.count > 0, item.name);
        assert.equal(catalog.characterName(item.source.at(0)).length > 0, true, item.name);
      }
    }
    assert.equal(total, 172808);
    assert.equal(catalog.categories.find((category) => category.name === "Han")!.source.count, 114327);
  });

  it("names characters and shows the Unicode code point", () => {
    assert.equal(formatCodePoint(0x00e9), "U+00E9");
    assert.equal(formatCodePoint(0x1f600), "U+1F600");
    assert.equal(catalog.characterName(0x00e9), "LATIN SMALL LETTER E WITH ACUTE");
    assert.equal(catalog.characterName(0x20ac), "EURO SIGN");
    assert.equal(catalog.characterName(0x2192), "RIGHTWARDS ARROW");
    assert.equal(catalog.characterName(0x2713), "CHECK MARK");
    assert.equal(catalog.characterName(0x4e00), "CJK UNIFIED IDEOGRAPH-4E00");
    assert.equal(catalog.characterName(0x20000), "CJK UNIFIED IDEOGRAPH-20000");
    assert.equal(catalog.characterName(0xac00), "HANGUL SYLLABLE GA");
    assert.equal(catalog.characterName(0xc544), "HANGUL SYLLABLE A");
    assert.equal(catalog.characterName(0xd7a3), "HANGUL SYLLABLE HIH");
    assert.equal(hangulName(0xac00), "HANGUL SYLLABLE GA");
    assert.equal(catalog.characterName(0x1f600), "GRINNING FACE");
    assert.equal(catalog.glyphFor(0x0301), "\u25CC\u0301");
    assert.equal(catalog.characterName(0x0301), "COMBINING ACUTE ACCENT");
    assert.equal(contains(block("Latin", "Latin-1 Supplement").source, 0x00e9), true);
    assert.equal(contains(block("Symbol", "Currency Symbols").source, 0x20ac), true);
    assert.equal(contains(block("Symbol", "Arrows").source, 0x2192), true);
    assert.equal(contains(block("Symbol", "Emoticons").source, 0x1f600), true);
    assert.equal(contains(block("Han", "CJK Unified Ideographs").source, 0x4e00), true);
    assert.equal(contains(block("Han", "CJK Unified Ideographs").source, 0x9fff), true);
    assert.ok(block("Han", "CJK Unified Ideographs").count > 20000);
  });

  it("leaves out controls, surrogates, private use, and noncharacters", () => {
    for (const cp of [0x0, 0x7f, 0x9, 0xa, 0xd800, 0xdfff, 0xe000, 0xf8ff, 0xfdd0, 0xfffe, 0xffff, 0x10fffd, 0x10ffff]) {
      assert.equal(catalog.isAssigned(cp), false, formatCodePoint(cp));
      assert.equal(catalog.characterName(cp), "");
    }
  });

  it("searches by official name and by code point", () => {
    assert.equal(parseCodePoint("U+00E9"), 0xe9);
    assert.equal(parseCodePoint("00e9"), 0xe9);
    assert.equal(parseCodePoint("0x2192"), 0x2192);
    assert.equal(parseCodePoint("euro"), null);
    assert.equal(parseCodePoint("e"), null);

    const euro = catalog.searchCharacters("euro");
    assert.equal(contains(euro, 0x20ac), true);
    assert.equal(catalog.characterName(euro.at(euro.count - 1)).includes("EURO") || contains(euro, 0x20ac), true);

    for (const query of ["U+00E9", "00E9", "u+e9", "é"]) {
      const found = catalog.searchCharacters(query);
      assert.equal(contains(found, 0xe9), true, query);
    }
    assert.equal(contains(catalog.searchCharacters("rightwards arrow"), 0x2192), true);
    assert.equal(contains(catalog.searchCharacters("check"), 0x2713), true);
    assert.equal(catalog.searchCharacters("zzzqqq").count, 0);
    assert.equal(catalog.searchCharacters("   ").count, 0);

    const started = performance.now();
    const cjk = catalog.searchCharacters("cjk");
    const ideograph = catalog.searchCharacters("4e00");
    const letter = catalog.searchCharacters("e");
    assert.ok(performance.now() - started < 1500, "name and code point search stayed responsive");
    assert.ok(cjk.count > 100000);
    assert.equal(contains(cjk, 0x4e00), true);
    assert.equal(contains(ideograph, 0x4e00), true);
    assert.ok(letter.count > 1000);
    assert.equal(cjk.at(cjk.count - 1) > 0x4e00, true);
  });
});

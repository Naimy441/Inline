import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SPECIAL_CHARACTER_GROUPS } from "./specialCharacters";

const chars = SPECIAL_CHARACTER_GROUPS.flatMap((group) => group.chars.map(([char]) => char));
const names = new Map(SPECIAL_CHARACTER_GROUPS.flatMap((group) => group.chars.map(([char, name]) => [char, name] as const)));

function has(char: string) {
  return names.has(char);
}

describe("special characters", () => {
  it("covers the categories people insert, and none of them are emoji", () => {
    assert.deepEqual(
      SPECIAL_CHARACTER_GROUPS.map((group) => group.name),
      ["Punctuation", "Symbols", "Arrows", "Math", "Currency", "Numbers", "Latin", "Greek", "Letterlike", "Geometric", "Enclosed", "Technical", "Music", "Modifiers", "Box drawing"],
    );
    assert.ok(chars.length > 1000, `expected a broad set, got ${chars.length}`);
    for (const group of SPECIAL_CHARACTER_GROUPS) assert.ok(group.chars.length >= 40, group.name);
  });

  it("includes the punctuation, symbols, arrows, math and currency people look up", () => {
    for (const char of ["—", "–", "…", "“", "”", "‘", "’", "«", "»", "•", "§", "¶", "©", "®", "™", "€", "£", "¥", "₹", "←", "→", "↑", "↓", "∞", "√", "≠", "±", "α", "Ω", "é", "ñ", "✓", "★"]) {
      assert.ok(has(char), char);
    }
    assert.match(names.get("€")!, /euro/);
    assert.match(names.get("✓")!, /check/);
    assert.match(names.get("→")!, /arrow/);
  });

  it("does not include emoji", () => {
    assert.equal(SPECIAL_CHARACTER_GROUPS.some((group) => /emoji/i.test(group.name)), false);
    for (const char of ["😀", "🙂", "😉", "👍", "👎", "🎉", "✅", "❌", "⭐", "🔥", "🚀", "❤", "❤️", "⚡", "☀", "☎", "✉", "⚠", "☺", "☻"]) {
      assert.equal(has(char), false, char);
    }
    const textSymbols = new Set(["©", "®", "™", "‼", "⁉"]);
    for (const char of chars) {
      assert.equal([...char].length, 1, char);
      const cp = char.codePointAt(0)!;
      assert.equal(/\p{Emoji_Presentation}/u.test(char), false, char);
      const emojiBlock =
        (cp >= 0x1f300 && cp <= 0x1f5ff) ||
        (cp >= 0x1f600 && cp <= 0x1f64f) ||
        (cp >= 0x1f680 && cp <= 0x1f6ff) ||
        (cp >= 0x1f900 && cp <= 0x1f9ff) ||
        (cp >= 0x1fa70 && cp <= 0x1faff) ||
        (cp >= 0x1f1e6 && cp <= 0x1f1ff);
      assert.equal(emojiBlock, false, char);
      if (/\p{Emoji}/u.test(char)) assert.ok(textSymbols.has(char) || names.get(char)!.includes("arrow"), `${char} ${names.get(char)}`);
    }
  });
});

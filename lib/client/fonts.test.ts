import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { savedFontChoices, savedFontValue } from "@/lib/client/fonts";
import { FONT_FAMILIES } from "@/lib/doc/settings";

describe("saved font choices", () => {
  it("lists each imported family once, with its stand-in after it", () => {
    const choices = savedFontChoices(
      [
        { family: "Menlo (homework06)", fallback: "Arial" },
        { family: "Menlo (homework06)", fallback: "Arial" },
        { family: "Carlito", fallback: null },
        { family: "  ", fallback: null },
        { family: "Arial", fallback: null },
      ],
      ["Arial"],
    );
    assert.deepEqual(
      choices.map((choice) => choice.label),
      ["Carlito", "Menlo (homework06)"],
    );
    assert.equal(choices[1]!.value, `"Menlo (homework06)", ${FONT_FAMILIES[0]!.value}`);
    assert.equal(choices[0]!.value, '"Carlito", sans-serif');
  });

  it("quotes a stand-in that isn't one of the standard fonts", () => {
    assert.equal(savedFontValue(".SFNS (homework06)", "Computer Modern"), '".SFNS (homework06)", "Computer Modern", sans-serif');
    assert.equal(savedFontValue("Menlo", null), '"Menlo", monospace');
    assert.equal(savedFontChoices([{ family: "Menlo (notes)", fallback: "Courier New" }])[0]!.value, `"Menlo (notes)", ${FONT_FAMILIES.find((font) => font.label === "Courier New")!.value}`);
  });
});

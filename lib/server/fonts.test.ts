import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { listFonts, saveFont } from "@/lib/server/fonts";

// The store resolves its directory on every call, so this applies before any write.
process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-fonts-"));

/** Enough bytes to be kept; the library stores the file even when it isn't a full font. */
function bytes(seed: number) {
  const data = new Uint8Array(80);
  data[0] = seed;
  return data;
}

describe("the font library", () => {
  it("keeps a font from an import for every document, one file per family and style", async () => {
    const first = await saveFont({ family: "Menlo (homework06)", bold: false, italic: false, data: bytes(1) });
    const again = await saveFont({ family: "Menlo (homework06)", bold: false, italic: false, data: bytes(2) });
    const italic = await saveFont({ family: "Menlo (homework06)", bold: false, italic: true, data: bytes(3) });
    const word = await saveFont({ family: "Carlito", bold: false, italic: false, data: bytes(4) });
    assert.ok(first && italic && word);
    assert.equal(again?.id, first?.id, "a second document reuses the font the first one brought");
    const families = (await listFonts()).map((font) => `${font.family}${font.italic ? " italic" : ""}`);
    assert.deepEqual(families.sort(), ["Carlito", "Menlo (homework06)", "Menlo (homework06) italic"]);
  });
});

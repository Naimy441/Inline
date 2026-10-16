import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

// The store resolves its directory on each call, so this applies before any read.
process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-appearance-"));

import { savedAppearance, setSavedAppearance } from "@/lib/server/appearance";
import { writeSettingsFile } from "@/lib/server/store";

describe("saved appearance", () => {
  it("is light until the app has saved one, and then uses that", async () => {
    assert.equal(await savedAppearance(), "light");
    await writeSettingsFile("preferences", { googleImportDismissed: true, appearance: "dark" });
    assert.equal(await savedAppearance(), "dark");
    await writeSettingsFile("preferences", { googleImportDismissed: true, appearance: "light" });
    assert.equal(await savedAppearance(), "light");
    await writeSettingsFile("preferences", { googleImportDismissed: true });
    assert.equal(await savedAppearance(), "light");
  });

  it("a test pin replaces the saved value until it is cleared", async () => {
    await writeSettingsFile("preferences", { appearance: "dark" });
    setSavedAppearance("light");
    try {
      assert.equal(await savedAppearance(), "light");
    } finally {
      setSavedAppearance(null);
    }
    assert.equal(await savedAppearance(), "dark");
  });
});

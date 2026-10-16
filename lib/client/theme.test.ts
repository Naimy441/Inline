import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { appearanceToRemember } from "@/lib/client/theme";

describe("remembered appearance", () => {
  it("keeps a saved dark appearance when a window is merely on the light default", () => {
    assert.equal(appearanceToRemember(null, "light"), null);
    assert.equal(appearanceToRemember("", "light"), null);
  });

  it("stores an explicit choice and a dark page the system chose", () => {
    assert.equal(appearanceToRemember("dark", "dark"), "dark");
    assert.equal(appearanceToRemember("light", "light"), "light");
    assert.equal(appearanceToRemember(null, "dark"), "dark");
  });
});

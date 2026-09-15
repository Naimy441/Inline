import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retrieveChunks } from "./retrieve";
import { searchCitations } from "./citations";

describe("retrieveChunks", () => {
  it("ranks the passage that matches the query", () => {
    const document = [
      "Apples grow on trees in temperate climates.",
      "The committee adjourned after a long debate about tariffs.",
      "River silt makes the delta farmable.",
    ].join("\n\n");
    const [top] = retrieveChunks(document, "tariffs committee debate");
    assert.match(top.text, /committee/);
  });
});

describe("searchCitations", () => {
  it("finds catalog works by author or topic", () => {
    const orwell = searchCitations("orwell politics english");
    assert.ok(orwell.some((work) => /orwell/i.test(work.author)));
    const style = searchCitations("pinker style");
    assert.ok(style.some((work) => /pinker/i.test(work.author)));
  });
});

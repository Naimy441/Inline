import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { clearLookupCache, entryFromLexicon, lookupKey, lookupWord, matchCase } from "./lookup";

afterEach(() => clearLookupCache());

describe("dictionary entries", () => {
  it("groups definitions and drops the word itself from the synonyms", () => {
    const entry = entryFromLexicon(
      "ephemeral",
      [
        { word: "ephemera", defs: ["n\tA mayfly."] },
        {
          word: "ephemeral",
          defs: [
            "adj\tLasting for a short period of time.",
            "n\tSomething which lasts for a short period of time.",
            "adj\t(biology) Existing for only one day.",
            "adj\tLasting for a short period of time.",
          ],
        },
      ],
      [{ word: "fleeting" }, { word: "Ephemeral" }, { word: "short-lived" }, { word: "a passing thing" }],
    );
    assert.deepEqual(
      entry?.meanings.map((meaning) => meaning.partOfSpeech),
      ["adjective", "noun"],
    );
    assert.deepEqual(entry?.meanings[0]?.definitions, ["Lasting for a short period of time.", "(biology) Existing for only one day."]);
    assert.deepEqual(entry?.synonyms, ["fleeting", "short-lived"]);
  });

  it("is empty when nothing matches the word exactly", () => {
    assert.equal(entryFromLexicon("zorblat", [{ word: "zorbla", defs: ["n\tNope."] }], []), null);
  });
});

describe("looking a word up", () => {
  it("asks for the exact word and a synonym list", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("rel_syn=")) return Response.json([{ word: "fleeting" }]);
      return Response.json([{ word: "ephemeral", defs: ["adj\tLasting for a short period of time."] }]);
    };
    const entry = await lookupWord("Ephemeral's", fetchImpl);
    assert.equal(entry?.word, "ephemeral");
    assert.deepEqual(entry?.synonyms, ["fleeting"]);
    assert.equal(calls.length, 2);
    assert.ok(calls.some((url) => url.includes("sp=ephemeral")));
    assert.ok(calls.some((url) => url.includes("rel_syn=ephemeral")));
    calls.length = 0;
    assert.equal((await lookupWord("ephemeral", fetchImpl))?.word, "ephemeral");
    assert.deepEqual(calls, []);
  });

  it("reports a miss without calling the dictionary for a non-word", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return Response.json([]);
    };
    assert.equal(await lookupWord("...", fetchImpl), null);
    assert.equal(called, false);
    assert.equal(lookupKey("John's"), "john");
  });

  it("matches the case of the word being replaced", () => {
    assert.equal(matchCase("ephemeral", "fleeting"), "fleeting");
    assert.equal(matchCase("Ephemeral", "fleeting"), "Fleeting");
    assert.equal(matchCase("EPHEMERAL", "fleeting"), "FLEETING");
    assert.equal(matchCase("iPhone", "mobile"), "mobile");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorState } from "prosemirror-state";
import type { Decoration, DecorationSet } from "prosemirror-view";
import { markdownToDoc } from "../doc/markdown";
import type { SpellChecker } from "../doc/words";
import { normalizeWord, setDictionary, setSpellcheckEnabled, spellingPlugin, wordAt } from "./spelling";

function decorations(state: EditorState): Decoration[] {
  const plugin = state.plugins.find((item) => (item as unknown as { key: string }).key.startsWith("spelling"))!;
  const set = plugin.props.decorations!.call(plugin, state) as DecorationSet;
  return set.find();
}

function quieted(state: EditorState) {
  return decorations(state).map((decoration) => state.doc.textBetween(decoration.from, decoration.to));
}

function underlined(state: EditorState) {
  return decorations(state)
    .filter((decoration) => decoration.spec.spelling === "spelling-error")
    .map((decoration) => state.doc.textBetween(decoration.from, decoration.to));
}

async function english(): Promise<SpellChecker> {
  const [{ default: nspell }, { default: dictionary }] = await Promise.all([import("nspell"), import("dictionary-en")]);
  const check = nspell({ aff: Buffer.from(dictionary.aff), dic: Buffer.from(dictionary.dic) });
  return { correct: (word) => check.correct(word) };
}

describe("the user's dictionary", () => {
  it("stops the browser underlining every occurrence of a dictionary word", () => {
    let state = EditorState.create({ doc: markdownToDoc("Zorblat met Zorblat’s friend.\n\nNo zorblat here? zorblat!"), plugins: [spellingPlugin([])] });
    assert.deepEqual(quieted(state), []);
    state = state.apply(setDictionary(state.tr, [normalizeWord("Zorblat")]));
    // The possessive too: a name in the dictionary is spelled as intended either way.
    assert.deepEqual(quieted(state), ["Zorblat", "Zorblat’s", "zorblat", "zorblat"]);
    // New text is covered as it's typed.
    state = state.apply(state.tr.insertText("Zorblat ", 1));
    assert.equal(quieted(state).length, 5);
  });

  it("finds the word at a position", () => {
    const state = EditorState.create({ doc: markdownToDoc("Hello wonderful world") });
    assert.equal(wordAt(state, 9)?.text, "wonderful");
    assert.equal(normalizeWord("Don’t"), "don't");
  });
});

describe("Hunspell underlines", () => {
  it("underlines righteois and leaves real words, code and equations alone", async () => {
    const check = await english();
    let state = EditorState.create({
      doc: markdownToDoc("A righteois claim. `codez` and $betta$ stay plain."),
      plugins: [spellingPlugin([], { check })],
    });
    assert.deepEqual(underlined(state), ["righteois"]);
    // A new typo is underlined as it's typed. Real words still are not.
    const end = state.doc.content.size - 1;
    state = state.apply(state.tr.insertText(" recieve righteous", end));
    assert.deepEqual(underlined(state), ["righteois", "recieve"]);
    // The user's dictionary clears the line, and hiding spelling clears all of them.
    state = state.apply(setDictionary(state.tr, [normalizeWord("righteois")]));
    assert.deepEqual(underlined(state), ["recieve"]);
    state = state.apply(setSpellcheckEnabled(state.tr, false));
    assert.deepEqual(underlined(state), []);
  });

  it("does not underline a word until the dictionary has answered", () => {
    let verdict: boolean | null = null;
    const check: SpellChecker = { correct: () => verdict };
    let state = EditorState.create({ doc: markdownToDoc("righteois"), plugins: [spellingPlugin([], { check })] });
    assert.deepEqual(underlined(state), []);
    verdict = false;
    state = state.apply(state.tr.insertText(" ", state.doc.content.size - 1));
    assert.deepEqual(underlined(state), ["righteois"]);
    verdict = true;
    state = state.apply(state.tr.insertText(" ", state.doc.content.size - 1));
    assert.deepEqual(underlined(state), []);
  });
});

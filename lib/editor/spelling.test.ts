import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorState } from "prosemirror-state";
import type { Decoration, DecorationSet } from "prosemirror-view";
import { markdownToDoc } from "../doc/markdown";
import { markAgentText } from "../doc/merge";
import { schema } from "../doc/schema";
import type { SpellChecker } from "../doc/words";
import { englishDictionary } from "../server/spellcheck";
import { hasSpellingUnderline, normalizeWord, setDictionary, setSpellcheckEnabled, spellingPlugin, wordAt } from "./spelling";

function decorations(state: EditorState): Decoration[] {
  const plugin = state.plugins.find((item) => (item as unknown as { key: string }).key.startsWith("spelling"))!;
  const set = plugin.props.decorations!.call(plugin, state) as DecorationSet;
  return set.find();
}

function quieted(state: EditorState) {
  return decorations(state).map((decoration) => state.doc.textBetween(decoration.from, decoration.to));
}

function textMarks(state: EditorState, text: string) {
  let marks: string | null = null;
  state.doc.descendants((node) => {
    if (node.isText && node.text === text) marks = node.marks.map((mark) => mark.type.name).join(",");
  });
  return marks;
}

function underlined(state: EditorState) {
  return decorations(state)
    .filter((decoration) => decoration.spec.spelling === "spelling-error")
    .map((decoration) => state.doc.textBetween(decoration.from, decoration.to));
}

async function english(): Promise<SpellChecker> {
  const { default: nspell } = await import("nspell");
  const check = nspell(englishDictionary());
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
    const typo = wordAt(state, state.doc.textContent.indexOf("righteois") + 1);
    const real = wordAt(state, 2);
    assert.equal(typo?.text, "righteois");
    assert.equal(real?.text, "A");
    assert.equal(typo ? hasSpellingUnderline(state, typo.from, typo.to) : false, true);
    assert.equal(real ? hasSpellingUnderline(state, real.from, real.to) : true, false);
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

  it("accepts ordinary words the old word list missed, and still flags misspellings", async () => {
    const check = await english();
    assert.equal(check.correct("unshifted"), true);
    assert.equal(check.correct("wireframe"), true);
    assert.equal(check.correct("subspaces"), true);
    assert.equal(check.correct("Minkowski"), true);
    assert.equal(check.correct("righteous"), true);
    assert.equal(check.correct("righteois"), false);
    assert.equal(check.correct("recieve"), false);
  });

  it("does not underline text Claude inserted, and a replacement takes the old underline with it", () => {
    const agent = schema.marks.agent.create();
    const check: SpellChecker = { correct: (word) => word !== "righteois" && word !== "recieve" };
    const plugin = spellingPlugin([], { check });
    let state = EditorState.create({
      doc: schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, schema.text("righteois"))]),
      plugins: [plugin],
    });
    assert.deepEqual(underlined(state), ["righteois"]);
    // Claude replaces the misspelling. The new word is not checked, even when it would have been a typo.
    state = state.apply(state.tr.replaceWith(1, 10, schema.text("recieve", [agent])).setMeta("addToHistory", false));
    assert.deepEqual(underlined(state), []);
    // Text Claude wrote next to a user typo stays plain; the typo is still marked.
    state = EditorState.create({
      doc: schema.nodes.doc.create(null, [
        schema.nodes.paragraph.create(null, [schema.text("recieve", [agent]), schema.text(" righteois")]),
      ]),
      plugins: [plugin],
    });
    assert.deepEqual(underlined(state), ["righteois"]);
  });

  it("checks characters the user types into text Claude wrote", () => {
    const agent = schema.marks.agent.create();
    const check: SpellChecker = { correct: (word) => word !== "qq" };
    const plugin = spellingPlugin([], { check });
    const state = EditorState.create({
      doc: schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, schema.text("righteois", [agent]))]),
      plugins: [plugin],
    });
    assert.deepEqual(underlined(state), []);
    const tr = state.tr.insertText("qq", 5);
    let next = state.apply(tr);
    assert.equal(next.doc.textContent, "righqqteois");
    assert.equal(next.doc.firstChild?.firstChild?.marks.some((mark) => mark.type.name === "agent"), true);
    const extra = plugin.spec.appendTransaction?.call(plugin, [tr], state, next);
    if (extra) next = next.apply(extra);
    assert.equal(textMarks(next, "qq"), "");
    assert.deepEqual(underlined(next), ["qq"]);
    assert.equal(textMarks(next, "righ"), "agent");
    assert.equal(textMarks(next, "teois"), "agent");
  });

  it("does not underline a page of text Claude wrote", () => {
    const check: SpellChecker = { correct: () => false };
    const state = EditorState.create({
      doc: markAgentText(markdownToDoc("A wireframe in Minkowski space. righteois")),
      plugins: [spellingPlugin([], { check })],
    });
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

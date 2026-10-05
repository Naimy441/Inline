import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sendableSteps } from "prosemirror-collab";
import { EditorState, type Plugin } from "prosemirror-state";
import type { DecorationSet } from "prosemirror-view";
import { ensureBlockIds } from "../doc/ids";
import { markdownToDoc } from "../doc/markdown";
import type { HunkJSON } from "../doc/review";
import { schema } from "../doc/schema";
import { commentRanges } from "./comments";
import { findMatches, findState, setFindQuery } from "./find";
import { invisiblesShown, setInvisibles } from "./invisibles";
import { mappedHunks, setHunks } from "./review";
import { editorPlugins } from "./setup";

function stateFor(markdown: string, options: { readOnly?: () => boolean; showInvisibles?: boolean } = {}) {
  return EditorState.create({
    doc: ensureBlockIds(markdownToDoc(markdown)),
    plugins: editorPlugins({
      version: 0,
      clientID: "test",
      review: { review: () => undefined },
      onActivateComment: () => undefined,
      geometry: () => ({ pageHeight: 1056, marginTop: 96, marginBottom: 96, gap: 24 }),
      ...options,
    }),
  });
}

function decorationClasses(state: EditorState) {
  const classes: string[] = [];
  for (const plugin of state.plugins as Plugin[]) {
    const set = plugin.props.decorations?.call(plugin, state) as DecorationSet | null | undefined;
    if (!set) continue;
    for (const decoration of set.find()) {
      const attrs = (decoration as unknown as { type: { attrs?: { class?: string } } }).type.attrs;
      if (attrs?.class) classes.push(attrs.class);
    }
  }
  return classes;
}

function hunk(overrides: Partial<HunkJSON>): HunkJSON {
  return { id: "h1", from: 1, to: 1, author: "chat", createdAt: 0, deleted: { content: [] } as unknown as HunkJSON["deleted"], deletedText: "", insertedText: "", ...overrides };
}

describe("viewing mode", () => {
  it("refuses local edits but keeps selection changes", () => {
    let viewing = true;
    const state = stateFor("Read only", { readOnly: () => viewing });
    const typed = state.apply(state.tr.insertText("X", 1));
    assert.equal(typed.doc.textContent, "Read only");
    viewing = false;
    const allowed = state.apply(state.tr.insertText("X", 1));
    assert.equal(allowed.doc.textContent, "XRead only");
  });

  it("still applies changes that arrive from the server", () => {
    const state = stateFor("Remote", { readOnly: () => true });
    const remote = state.tr.insertText("New ", 1).setMeta("rebased", 0);
    assert.equal(state.apply(remote).doc.textContent, "New Remote");
  });
});

describe("collab", () => {
  it("queues local steps until the server confirms them", () => {
    const state = stateFor("Hello");
    assert.equal(sendableSteps(state), null);
    const typed = state.apply(state.tr.insertText("!", 6));
    assert.equal(sendableSteps(typed)?.steps.length, 1);
  });
});

describe("non-printing characters", () => {
  it("marks paragraph ends and spaces only while switched on", () => {
    const state = stateFor("Two words\n\nNext");
    assert.equal(invisiblesShown(state), false);
    const on = state.apply(setInvisibles(state.tr, true));
    assert.equal(invisiblesShown(on), true);
    const classes = decorationClasses(on);
    assert.equal(classes.filter((name) => name === "np-space").length, 1);
    const off = on.apply(setInvisibles(on.tr, false));
    assert.equal(decorationClasses(off).filter((name) => name === "np-space").length, 0);
  });

  it("follows typing", () => {
    const on = stateFor("One", { showInvisibles: true });
    const typed = on.apply(on.tr.insertText(" two three", 4));
    assert.equal(decorationClasses(typed).filter((name) => name === "np-space").length, 2);
  });
});

describe("review decorations", () => {
  it("maps hunks through unconfirmed local typing", () => {
    const state = stateFor("Alpha beta");
    const withHunk = state.apply(setHunks(state.tr, [hunk({ from: 7, to: 11, insertedText: "beta" })], 0));
    assert.deepEqual(mappedHunks(withHunk).map((h) => [h.mappedFrom, h.mappedTo]), [[7, 11]]);
    const typed = withHunk.apply(withHunk.tr.insertText("Very ", 1));
    assert.deepEqual(mappedHunks(typed).map((h) => [h.mappedFrom, h.mappedTo]), [[12, 16]]);
  });

  it("colors the user's suggestions differently from Claude's edits", () => {
    const state = stateFor("Alpha beta gamma");
    const next = state.apply(
      setHunks(
        state.tr,
        [hunk({ id: "a", from: 1, to: 6, insertedText: "Alpha", author: "chat" }), hunk({ id: "b", from: 12, to: 17, insertedText: "gamma", author: "user" })],
        0,
      ),
    );
    const classes = decorationClasses(next).filter((name) => name.startsWith("review-insert"));
    assert.equal(classes.length, 2);
    assert.equal(classes.filter((name) => name.includes("is-suggestion")).length, 1);
  });

  it("ignores hunks for a version the editor hasn't reached", () => {
    const state = stateFor("Alpha");
    const ahead = state.apply(setHunks(state.tr, [hunk({ from: 1, to: 6, insertedText: "Alpha" })], 3));
    assert.equal(mappedHunks(ahead).length, 0);
  });
});

describe("find", () => {
  const doc = ensureBlockIds(markdownToDoc("The cat sat. THE end.\n\nCatalog the cats."));

  it("matches case-insensitively by default", () => {
    assert.equal(findMatches(doc, { text: "the", caseSensitive: false, wholeWord: false, regex: false }).length, 3);
  });

  it("respects case, whole words and regular expressions", () => {
    assert.equal(findMatches(doc, { text: "the", caseSensitive: true, wholeWord: false, regex: false }).length, 1);
    assert.equal(findMatches(doc, { text: "cat", caseSensitive: false, wholeWord: true, regex: false }).length, 1);
    assert.equal(findMatches(doc, { text: "cats?\\b", caseSensitive: false, wholeWord: false, regex: true }).length, 2);
    assert.deepEqual(findMatches(doc, { text: "(", caseSensitive: false, wholeWord: false, regex: true }), [], "an invalid pattern finds nothing");
  });

  it("returns document positions that select the matched text", () => {
    const [match] = findMatches(doc, { text: "sat", caseSensitive: false, wholeWord: false, regex: false });
    assert.equal(doc.textBetween(match!.from, match!.to), "sat");
  });

  it("keeps the query and matches in plugin state", () => {
    const state = stateFor("one two one");
    const next = state.apply(setFindQuery(state.tr, { text: "one", caseSensitive: false, wholeWord: false, regex: false }));
    assert.equal(findState(next)?.matches.length, 2);
  });
});

describe("comment anchors", () => {
  it("collects each comment's range across marked text", () => {
    const state = stateFor("Mark these words please");
    const mark = schema.mark("comment", { id: "c1" });
    const marked = state.apply(state.tr.addMark(6, 17, mark));
    assert.deepEqual(commentRanges(marked).get("c1"), { from: 6, to: 17 });
  });
});

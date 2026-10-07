import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { canMoveFolder, documentFolder, folderPath, MAX_FOLDER_DEPTH, summarizeFolders, type Folder } from "@/lib/doc/folders";
import { DEFAULT_SETTINGS, type DocumentMeta } from "@/lib/doc/settings";

const folder = (id: string, parentId: string | null = null): Folder => ({ id, name: id, parentId, color: "gray", createdAt: 0, updatedAt: 0 });
const tree = (...list: Folder[]) => new Map(list.map((item) => [item.id, item]));
const doc = (id: string, folderId?: string, at = 0, words = 10): DocumentMeta => ({
  id,
  title: id,
  createdAt: 0,
  updatedAt: at,
  lastOpenedAt: at,
  trashedAt: null,
  settings: DEFAULT_SETTINGS,
  wordCount: words,
  preview: "",
  ...(folderId ? { folderId } : {}),
});

describe("folder tree", () => {
  const folders = tree(folder("work"), folder("q3", "work"), folder("okrs", "q3"), folder("home"));

  test("a folder's path runs from the top level down", () => {
    assert.deepEqual(folderPath(folders, "okrs").map((item) => item.id), ["work", "q3", "okrs"]);
    assert.deepEqual(folderPath(folders, null), []);
    assert.deepEqual(folderPath(folders, "missing"), []);
  });

  test("a path stops at a loop instead of running forever", () => {
    const looped = tree(folder("a", "b"), folder("b", "a"));
    assert.equal(folderPath(looped, "a").length, 2);
  });

  test("folders can't move into themselves or a folder inside them", () => {
    assert.equal(canMoveFolder(folders, "work", "okrs"), false);
    assert.equal(canMoveFolder(folders, "work", "work"), false);
    assert.equal(canMoveFolder(folders, "okrs", "home"), true);
    assert.equal(canMoveFolder(folders, "q3", null), true);
    assert.equal(canMoveFolder(folders, "q3", "missing"), false);
  });

  test("nesting is capped", () => {
    const chain = Array.from({ length: MAX_FOLDER_DEPTH }, (_, index) => folder(`f${index}`, index ? `f${index - 1}` : null));
    const deep = tree(...chain, folder("extra"));
    assert.equal(canMoveFolder(deep, "extra", `f${MAX_FOLDER_DEPTH - 2}`), true);
    assert.equal(canMoveFolder(deep, "extra", `f${MAX_FOLDER_DEPTH - 1}`), false);
  });

  test("a document whose folder is gone shows at the top level", () => {
    assert.equal(documentFolder(folders, doc("a", "q3")), "q3");
    assert.equal(documentFolder(folders, doc("a", "deleted")), null);
    assert.equal(documentFolder(folders, doc("a")), null);
  });

  test("summaries count everything inside, latest first", () => {
    const summaries = summarizeFolders(folders, [doc("plan", "work", 1), doc("goals", "okrs", 5), doc("loose", undefined, 9), doc("orphan", "deleted", 3)]);
    const work = summaries.get("work")!;
    assert.deepEqual(work.documents.map((item) => item.id), ["goals", "plan"]);
    assert.equal(work.folders, 2);
    assert.equal(work.updatedAt, 5);
    assert.deepEqual(summaries.get("q3")!.documents.map((item) => item.id), ["goals"]);
    assert.equal(summaries.get("home")!.documents.length, 0);
  });
});

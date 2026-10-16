import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { docxFilesInFolder } from "./homeImport";

/** A file as a folder picker would hand it over, path and all. */
function picked(name: string, relativePath = ""): File {
  const file = new File(["x"], name);
  Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  return file;
}

describe("Word files in a picked folder", () => {
  test("keeps .docx files from the folder and from nested folders", () => {
    const files = docxFilesInFolder([
      picked("readme.txt", "Notes/readme.txt"),
      picked("Budget.docx", "Notes/Budget.docx"),
      picked("Q3.docx", "Notes/Clients/Q3.docx"),
      picked("photo.jpg", "Notes/Clients/photo.jpg"),
      picked("Plan.DOCX", "Notes/Plan.DOCX"),
    ]);
    assert.deepEqual(files.map((file) => file.webkitRelativePath), ["Notes/Budget.docx", "Notes/Clients/Q3.docx", "Notes/Plan.DOCX"]);
  });

  test("skips Word lock files and macOS metadata, and sorts by path", () => {
    const files = docxFilesInFolder([
      picked("z.docx", "Export/z.docx"),
      picked("~$z.docx", "Export/~$z.docx"),
      picked("a.docx", "Export/__MACOSX/a.docx"),
      picked("b.docx", "Export/b.docx"),
    ]);
    assert.deepEqual(files.map((file) => file.name), ["b.docx", "z.docx"]);
  });

  test("uses the file name when the picker gives no relative path", () => {
    const files = docxFilesInFolder([picked("Alone.docx"), picked("notes.md")]);
    assert.deepEqual(files.map((file) => file.name), ["Alone.docx"]);
  });

  test("an empty folder, or one with no Word files, yields nothing", () => {
    assert.deepEqual(docxFilesInFolder([]), []);
    assert.deepEqual(docxFilesInFolder([picked("notes.txt", "Folder/notes.txt")]), []);
  });
});

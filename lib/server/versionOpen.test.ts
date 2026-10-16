import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_SETTINGS } from "@/lib/doc/settings";
import { documentRepoPath, hasUnsavedChanges, saveDocumentVersion, versionArtifacts, writeWorkspaceFile, type VersionFilesError } from "@/lib/server/repo";
import { writeDocumentFile, type StoredDocumentFile } from "@/lib/server/store";
import { openVersionOnDisk } from "@/lib/server/versionOpen";

process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-version-open-"));

function docFile(id: string, text = "Hello"): StoredDocumentFile {
  return {
    format: 3,
    meta: {
      id,
      title: "T",
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
      trashedAt: null,
      settings: DEFAULT_SETTINGS,
      wordCount: 1,
      preview: text,
    },
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
    comments: [],
    hunks: [],
  };
}

const save = (id: string, label: string) => saveDocumentVersion(id, { label, author: "user", title: "T", wordCount: 1, pending: 0 });

describe("version files on disk", () => {
  it("opens one saved file, and the folder holds that version rather than later edits", async () => {
    await writeDocumentFile(docFile("open", "Page"));
    await writeWorkspaceFile("open", "notes/a.txt", "alpha");
    await writeWorkspaceFile("open", "chart.py", "print(1)\n");
    const saved = await save("open", "With files");
    await writeWorkspaceFile("open", "notes/a.txt", "beta");
    await writeWorkspaceFile("open", "chart.py", "print(2)\n");

    const opened: string[] = [];
    const revealed: Array<{ folder: string; isFile: boolean }> = [];
    const file = await openVersionOnDisk("open", saved.id, "notes/a.txt", {
      openFile: async (target) => {
        opened.push(target);
      },
    });
    assert.deepEqual(opened, [file.file]);
    assert.equal(readFileSync(opened[0]!, "utf8"), "alpha");
    assert.equal(statSync(opened[0]!).isFile(), true);
    assert.notEqual(opened[0], file.folder);
    assert.equal(readFileSync(path.join(documentRepoPath("open"), "notes", "a.txt"), "utf8"), "beta");
    assert.equal(await hasUnsavedChanges("open"), true);

    const folder = await openVersionOnDisk("open", saved.id, undefined, {
      reveal: async (target, isFile) => {
        revealed.push({ folder: target, isFile });
      },
    });
    assert.deepEqual(revealed, [{ folder: folder.folder, isFile: false }]);
    assert.equal(existsSync(path.join(folder.folder, "document.json")), false);
    assert.equal(readFileSync(path.join(folder.folder, "notes", "a.txt"), "utf8"), "alpha");
    assert.equal(readFileSync(path.join(folder.folder, "chart.py"), "utf8"), "print(1)\n");
    assert.equal(statSync(folder.folder).isDirectory(), true);

    await assert.rejects(() => versionArtifacts("open", saved.id, "document.json"), /isn't in this version/);
    await assert.rejects(() => versionArtifacts("open", saved.id, "../notes/a.txt"), /isn't in this version/);
    await assert.rejects(() => versionArtifacts("open", "nope"), /Version not found/);
  });

  it("opens the current file itself and the document folder", async () => {
    await writeDocumentFile(docFile("live", "Page"));
    await writeWorkspaceFile("live", "notes/a.txt", "now");
    const opened: string[] = [];
    const file = await openVersionOnDisk("live", null, "notes/a.txt", {
      openFile: async (target) => {
        opened.push(target);
      },
    });
    assert.equal(readFileSync(opened[0]!, "utf8"), "now");
    assert.equal(opened[0], file.file);
    const revealed: Array<{ folder: string; isFile: boolean }> = [];
    const folder = await openVersionOnDisk("live", null, undefined, {
      reveal: async (target, isFile) => {
        revealed.push({ folder: target, isFile });
      },
    });
    assert.equal(revealed[0]!.isFile, false);
    assert.equal(revealed[0]!.folder, folder.folder);
    assert.equal(existsSync(path.join(folder.folder, "notes", "a.txt")), true);
  });

  it("does not follow a symlink out of the version folder", async () => {
    await writeDocumentFile(docFile("linked", "Page"));
    await writeWorkspaceFile("linked", "ok.txt", "inside");
    symlinkSync("/etc/passwd", path.join(documentRepoPath("linked"), "leak.txt"));
    const saved = await save("linked", "Linked");
    assert.ok(saved.files.includes("leak.txt"));
    await assert.rejects(() => versionArtifacts("linked", saved.id, "leak.txt"), (error: VersionFilesError) => {
      assert.match(error.message, /isn't in this version/);
      return true;
    });
    const folder = await versionArtifacts("linked", saved.id, "ok.txt");
    assert.equal(readFileSync(folder.file!, "utf8"), "inside");
    assert.equal(existsSync(path.join(folder.folder, "leak.txt")), false);
  });

  it("refuses a version that saved no files", async () => {
    await writeDocumentFile(docFile("emptyopen", "Only"));
    const saved = await save("emptyopen", "Only page");
    await assert.rejects(() => versionArtifacts("emptyopen", saved.id), /no files/);
  });
});

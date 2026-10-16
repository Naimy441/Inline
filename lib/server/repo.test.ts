import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_SETTINGS } from "@/lib/doc/settings";
import {
  UnsavedChangesError,
  deleteWorkspaceFile,
  discardDraft,
  documentRepoPath,
  hasUnsavedChanges,
  listDocumentVersions,
  listWorkspaceFiles,
  readDocumentVersion,
  readWorkspaceText,
  resolveInside,
  restoreDocumentVersion,
  runWorkspaceCommand,
  saveDocumentVersion,
  snapshotRewind,
  writeDraft,
  writeWorkspaceFile,
} from "@/lib/server/repo";
import { dataDir, documentFilePath, readDocumentFile, writeDocumentFile, type StoredDocumentFile } from "@/lib/server/store";

process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-repo-"));

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

const save = (id: string, label: string, author: "user" | "claude" = "user") =>
  saveDocumentVersion(id, { label, author, title: "T", wordCount: 1, pending: 0 });

describe("git versions", () => {
  it("writes the working tree without committing, then a save is a commit", async () => {
    await writeDocumentFile(docFile("plain", "Hello"));
    assert.deepEqual(await listDocumentVersions("plain"), []);
    assert.equal(await hasUnsavedChanges("plain"), true);
    const saved = await save("plain", "First");
    assert.match(saved.id, /^[0-9a-f]{40}$/);
    assert.equal(saved.author, "user");
    assert.equal(await hasUnsavedChanges("plain"), false);
    await assert.rejects(save("plain", "Again"), /Nothing has changed/);

    await writeDocumentFile(docFile("plain", "Hello there"));
    assert.equal(await hasUnsavedChanges("plain"), true);
    const second = await save("plain", "Second", "claude");
    const listed = await listDocumentVersions("plain");
    assert.deepEqual(
      listed.map((version) => version.label),
      ["Second", "First"],
    );
    assert.equal(listed[0]!.author, "claude");
    assert.equal(listed[0]!.id, second.id);
  });

  it("refuses to restore over unsaved work, then restores the document and a file", async () => {
    await writeDocumentFile(docFile("files", "One"));
    await writeWorkspaceFile("files", "notes/a.txt", "alpha");
    const saved = await save("files", "With a note");
    assert.deepEqual(saved.files, ["notes/a.txt"]);
    await writeWorkspaceFile("files", "notes/a.txt", "beta");
    await writeDocumentFile(docFile("files", "Two"));
    await assert.rejects(restoreDocumentVersion("files", saved.id), UnsavedChangesError);
    assert.match((await readDocumentFile("files"))!.meta.preview, /Two/);
    const restored = await restoreDocumentVersion("files", saved.id, { discard: true });
    assert.equal(restored.label, "With a note");
    assert.equal((await readDocumentFile("files"))!.meta.preview, "One");
    const note = await readWorkspaceText("files", "notes/a.txt");
    assert.equal(note.kind === "text" && note.text, "alpha");
    assert.deepEqual(
      (await listDocumentVersions("files")).map((version) => version.label),
      ["With a note"],
    );
  });

  it("keeps a rewind snapshot off the version list", async () => {
    await writeDocumentFile(docFile("rewind", "Before"));
    const id = await snapshotRewind("rewind", "Before edits");
    assert.match(id, /^[0-9a-f]{40}$/);
    assert.deepEqual(await listDocumentVersions("rewind"), []);
    await writeDocumentFile(docFile("rewind", "After"));
    const stored = await readDocumentVersion("rewind", id);
    assert.equal((stored!.doc as { content: Array<{ content: Array<{ text: string }> }> }).content[0]!.content[0]!.text, "Before");
    await restoreDocumentVersion("rewind", id, { discard: true });
    assert.equal((await readDocumentFile("rewind"))!.meta.preview, "Before");
  });

  it("does not commit a draft", async () => {
    await writeDocumentFile(docFile("drafts", "Live"));
    await writeDraft("drafts", { type: "doc", content: [] });
    const saved = await save("drafts", "Live only");
    assert.deepEqual(saved.files, []);
    assert.equal((await listWorkspaceFiles("drafts")).some((file) => file.path.startsWith(".draft")), false);
    await discardDraft("drafts");
  });
});

describe("the folder stays inside the document", () => {
  it("refuses paths that leave the folder, including a symlink", async () => {
    await writeDocumentFile(docFile("jail", "Safe"));
    await writeWorkspaceFile("jail", "ok.txt", "inside");
    const root = documentRepoPath("jail");
    symlinkSync("/etc/passwd", path.join(root, "leak.txt"));
    assert.match(await resolveInside("jail", "ok.txt"), /ok\.txt$/);
    for (const bad of ["../ok.txt", "/etc/passwd", "document.json", ".git/HEAD", "leak.txt", "notes/../../ok.txt"]) {
      await assert.rejects(resolveInside("jail", bad), /folder|reserved|leaves/, bad);
    }
    await deleteWorkspaceFile("jail", "ok.txt");
  });
});

describe("legacy snapshots", () => {
  it("turns named versions into commits and drops automatic ones", async () => {
    const id = "legacy1";
    const documents = path.join(dataDir(), "documents");
    const versions = path.join(dataDir(), "versions", id);
    mkdirSync(versions, { recursive: true });
    const version = (name: string, author: string, text: string, createdAt: number) => {
      writeFileSync(
        path.join(versions, `${name}.json`),
        JSON.stringify({
          id: name,
          documentId: id,
          label: name,
          createdAt,
          author,
          title: "Old",
          wordCount: 1,
          doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
          hunks: [],
        }),
      );
    };
    version("first", "user", "Named one", 1_000);
    version("auto", "auto", "Automatic", 2_000);
    version("second", "claude", "Named two", 3_000);
    version("same", "user", "Named two", 4_000);
    mkdirSync(documents, { recursive: true });
    writeFileSync(path.join(documents, `${id}.json`), JSON.stringify(docFile(id, "Working copy")));

    const current = await readDocumentFile(id);
    assert.equal(current!.meta.preview, "Working copy");
    assert.equal(await import("node:fs").then((fs) => fs.existsSync(path.join(documents, `${id}.json`))), false);
    assert.equal(await import("node:fs").then((fs) => fs.existsSync(versions)), false);
    const listed = await listDocumentVersions(id);
    assert.deepEqual(
      listed.map((item) => [item.label, item.author]),
      [
        ["second", "claude"],
        ["first", "user"],
      ],
    );
    assert.equal(await hasUnsavedChanges(id), true, "the working copy is not itself a version");
  });
});

describe("sandboxed commands", () => {
  it("can write a file in the folder and cannot see the rest of the machine", async () => {
    await writeDocumentFile(docFile("box", "Stay"));
    const wrote = await runWorkspaceCommand("box", "python3 -c 'open(\"made.txt\",\"w\").write(\"from python\")'", 20_000);
    assert.equal(wrote.code, 0, wrote.stderr);
    const made = await readWorkspaceText("box", "made.txt");
    assert.equal(made.kind === "text" && made.text, "from python");

    const passwd = await runWorkspaceCommand("box", "python3 -c 'print(open(\"/etc/passwd\").read())'", 20_000);
    assert.equal(passwd.code, 0, passwd.stderr);
    assert.match(passwd.stdout, /^root:x:0:0:root:\/work:\/bin\/sh\s*$/);

    const host = await runWorkspaceCommand("box", "python3 -c 'open(\"/workspace/package.json\").read()'", 20_000);
    assert.notEqual(host.code, 0);

    const other = documentFilePath("plain");
    const stolen = await runWorkspaceCommand("box", `python3 -c 'open(${JSON.stringify(other)}).read()'`, 20_000);
    assert.notEqual(stolen.code, 0);

    const rewrite = await runWorkspaceCommand("box", "python3 -c 'open(\"document.json\",\"w\").write(\"nope\")'", 20_000);
    assert.notEqual(rewrite.code, 0);
    assert.equal((await readDocumentFile("box"))!.meta.preview, "Stay");
  });
});

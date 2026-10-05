import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_SETTINGS } from "@/lib/doc/settings";
import {
  assertSafeId,
  dataDir,
  deleteChatFile,
  deleteDocumentFile,
  deleteVersion,
  findUpload,
  listChatIds,
  listDocumentIds,
  listVersions,
  mimeForExtension,
  readChatFile,
  readDocumentFile,
  readVersion,
  saveUpload,
  uploadExtension,
  uploadsDir,
  workspaceDir,
  writeChatFile,
  writeDocumentFile,
  writeVersion,
  type StoredDocumentFile,
  type StoredVersion,
} from "@/lib/server/store";

process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-store-"));

function docFile(id: string, title = "T"): StoredDocumentFile {
  return {
    format: 3,
    meta: { id, title, createdAt: 1, updatedAt: 1, lastOpenedAt: 1, trashedAt: null, settings: DEFAULT_SETTINGS, wordCount: 0, preview: "" },
    doc: { type: "doc", content: [{ type: "paragraph" }] },
    comments: [],
    hunks: [],
  };
}

function version(documentId: string, id: string, createdAt: number): StoredVersion {
  return { id, documentId, label: id, createdAt, author: "user", title: "T", doc: { type: "doc" }, wordCount: 0 };
}

/** Run `fn` with the store pointed at a fresh, empty data directory. */
async function inFreshDir<T>(fn: () => Promise<T>) {
  const previous = process.env.INLINE_DATA_DIR;
  process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-store-fresh-"));
  try {
    return await fn();
  } finally {
    process.env.INLINE_DATA_DIR = previous;
  }
}

describe("assertSafeId", () => {
  it("accepts ids of letters, digits, - and _ up to 80 characters", () => {
    for (const id of ["a", "abc123", "A-b_C", "x".repeat(80)]) assert.equal(assertSafeId(id), id);
  });

  it("rejects path traversal, separators, empty and over-long ids", () => {
    for (const id of ["../x", "..", "a/b", "a\\b", "", "x".repeat(81), "a.json", "a b", "a\0b", "%2e%2e", "é"]) {
      assert.throws(() => assertSafeId(id), /Invalid id/, JSON.stringify(id));
    }
  });

  it("guards every id-taking helper", async () => {
    await assert.rejects(readDocumentFile("../secrets"), /Invalid id/);
    await assert.rejects(writeDocumentFile(docFile("a/b")), /Invalid id/);
    await assert.rejects(deleteDocumentFile(".."), /Invalid id/);
    await assert.rejects(readVersion("ok", "../x"), /Invalid id/);
    await assert.rejects(listVersions("../x"), /Invalid id/);
    await assert.rejects(writeVersion(version("../d", "v", 1)), /Invalid id/);
    await assert.rejects(readChatFile("../x"), /Invalid id/);
    await assert.rejects(writeChatFile("a/b", {}), /Invalid id/);
    await assert.rejects(saveUpload("../x", "png", new Uint8Array()), /Invalid id/);
    await assert.rejects(findUpload("../x"), /Invalid id/);
  });
});

describe("documents", () => {
  it("round-trips, lists and deletes document files", async () => {
    await writeDocumentFile(docFile("doc1", "First"));
    await writeDocumentFile(docFile("doc2", "Second"));
    assert.equal((await readDocumentFile("doc1"))!.meta.title, "First");
    assert.deepEqual((await listDocumentIds()).sort(), ["doc1", "doc2"]);
    await deleteDocumentFile("doc1");
    assert.equal(await readDocumentFile("doc1"), null);
    assert.deepEqual(await listDocumentIds(), ["doc2"]);
    // Deleting a missing document is not an error.
    await deleteDocumentFile("doc1");
  });

  it("reading a missing file returns null; a missing folder lists nothing", async () => {
    await inFreshDir(async () => {
      assert.equal(await readDocumentFile("nothing"), null);
      assert.deepEqual(await listDocumentIds(), []);
      assert.deepEqual(await listChatIds(), []);
      assert.deepEqual(await listVersions("nothing"), []);
    });
  });

  it("parallel writes to one file are serialized: valid JSON with the last value, no temp files left", async () => {
    const writes = Array.from({ length: 60 }, (_, i) => writeDocumentFile(docFile("busy", `Title ${i}`)));
    await Promise.all(writes);
    const file = path.join(dataDir(), "documents", "busy.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as StoredDocumentFile;
    assert.equal(parsed.meta.title, "Title 59");
    const leftovers = readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("parallel writes to different files all land", async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) => writeDocumentFile(docFile(`many${i}`, `M${i}`))));
    const files = await Promise.all(Array.from({ length: 30 }, (_, i) => readDocumentFile(`many${i}`)));
    assert.deepEqual(
      files.map((f) => f!.meta.title),
      Array.from({ length: 30 }, (_, i) => `M${i}`),
    );
  });

  it("concurrent readers never see a partially written file", async () => {
    const big = docFile("bigdoc", "x".repeat(200_000));
    await writeDocumentFile(big);
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i += 1) {
      jobs.push(writeDocumentFile(docFile("bigdoc", String(i).repeat(100_000))));
      jobs.push(readDocumentFile("bigdoc").then((file) => assert.ok(file && typeof file.meta.title === "string")));
    }
    await Promise.all(jobs);
  });

  it("a corrupt file surfaces a parse error rather than null", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(path.join(dataDir(), "documents"), { recursive: true });
    writeFileSync(path.join(dataDir(), "documents", "corrupt.json"), "{not json");
    await assert.rejects(readDocumentFile("corrupt"), SyntaxError);
  });
});

describe("versions", () => {
  it("lists versions newest first without their documents", async () => {
    await writeVersion(version("vdoc", "old", 100));
    await writeVersion(version("vdoc", "newest", 300));
    await writeVersion(version("vdoc", "middle", 200));
    const listed = await listVersions("vdoc");
    assert.deepEqual(listed.map((v) => v.id), ["newest", "middle", "old"]);
    assert.ok(listed.every((v) => !("doc" in v)));
    assert.deepEqual((await readVersion("vdoc", "middle"))!.doc, { type: "doc" });
    assert.equal(await readVersion("vdoc", "missing"), null);
  });

  it("deleteVersion removes one version", async () => {
    await writeVersion(version("vdel", "a", 1));
    await writeVersion(version("vdel", "b", 2));
    await deleteVersion("vdel", "a");
    assert.deepEqual((await listVersions("vdel")).map((v) => v.id), ["b"]);
  });

  it("deleteDocumentFile also removes the document's versions", async () => {
    await writeDocumentFile(docFile("withversions"));
    await writeVersion(version("withversions", "v1", 1));
    await writeVersion(version("withversions", "v2", 2));
    await writeVersion(version("other", "v1", 1));
    await deleteDocumentFile("withversions");
    assert.deepEqual(await listVersions("withversions"), []);
    assert.equal(await readVersion("withversions", "v1"), null);
    assert.equal((await listVersions("other")).length, 1);
  });
});

describe("chats", () => {
  it("round-trips, lists and deletes chat files", async () => {
    await inFreshDir(async () => {
      await writeChatFile("chat1", { messages: [1, 2] });
      await writeChatFile("chat2", { messages: [] });
      assert.deepEqual(await readChatFile<{ messages: number[] }>("chat1"), { messages: [1, 2] });
      assert.deepEqual((await listChatIds()).sort(), ["chat1", "chat2"]);
      await deleteChatFile("chat1");
      assert.equal(await readChatFile("chat1"), null);
      assert.deepEqual(await listChatIds(), ["chat2"]);
    });
  });
});

describe("uploads", () => {
  it("maps MIME types to extensions, ignoring case and parameters", () => {
    assert.equal(uploadExtension("image/png"), "png");
    assert.equal(uploadExtension("IMAGE/JPEG"), "jpg");
    assert.equal(uploadExtension("text/plain; charset=utf-8"), "txt");
    assert.equal(uploadExtension("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "docx");
    assert.equal(uploadExtension("application/x-msdownload"), null);
    assert.equal(uploadExtension(""), null);
  });

  it("maps extensions back to MIME types", () => {
    assert.equal(mimeForExtension("jpg"), "image/jpeg");
    assert.equal(mimeForExtension("svg"), "image/svg+xml");
    assert.equal(mimeForExtension("md"), "text/markdown");
    assert.equal(mimeForExtension("exe"), "application/octet-stream");
  });

  it("saves an upload and finds it again by id", async () => {
    const data = new Uint8Array([137, 80, 78, 71]);
    const file = await saveUpload("img1", "png", data);
    assert.equal(path.dirname(file), uploadsDir());
    assert.deepEqual(new Uint8Array(readFileSync(file)), data);
    const found = await findUpload("img1");
    assert.deepEqual(found, { file, extension: "png" });
    assert.equal(await findUpload("img"), null, "an id prefix must not match a longer id");
    assert.equal(await findUpload("missing"), null);
  });

  it("findUpload returns null when there is no uploads folder", async () => {
    await inFreshDir(async () => {
      assert.equal(await findUpload("anything"), null);
    });
  });

  it("workspaceDir creates the folder inside the data directory", async () => {
    const folder = await workspaceDir();
    assert.equal(folder, path.join(dataDir(), "workspace"));
    assert.ok(readdirSync(dataDir()).includes("workspace"));
  });
});

describe("dataDir", () => {
  it("follows INLINE_DATA_DIR at call time", async () => {
    const before = dataDir();
    await inFreshDir(async () => {
      assert.notEqual(dataDir(), before);
      assert.equal(dataDir(), path.resolve(process.env.INLINE_DATA_DIR!));
    });
    assert.equal(dataDir(), before);
  });
});

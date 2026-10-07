import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import { useTempDataDir } from "./support/mcp";

/** Importing Word files through the real route handler. */

useTempDataDir("inline-import-");

let route: typeof import("@/app/api/documents/import/route");
let hub: ReturnType<typeof import("@/lib/server/hub").documentHub>;
let docx: Uint8Array;

before(async () => {
  route = await import("@/app/api/documents/import/route");
  hub = (await import("@/lib/server/hub")).documentHub();
  const { documentToDocx } = await import("@/lib/doc/docx");
  const { markdownToDoc } = await import("@/lib/doc/markdown");
  const { DEFAULT_SETTINGS } = await import("@/lib/doc/settings");
  docx = await documentToDocx(
    markdownToDoc("# Budget {.title}\n\n## Costs\n\n- Rent\n- Staff\n\n| Item | Amount |\n| --- | --- |\n| Rent | 1200 |"),
    { id: "x", title: "Budget", createdAt: 0, updatedAt: 0, lastOpenedAt: 0, trashedAt: null, settings: DEFAULT_SETTINGS, wordCount: 0, preview: "" },
    async () => null,
  );
});

function upload(name: string, data: Uint8Array | string) {
  const form = new FormData();
  form.append("file", new File([typeof data === "string" ? data : Buffer.from(data)], name));
  return route.POST(new Request("http://localhost:3000/api/documents/import", { method: "POST", body: form }), {} as never);
}

describe("importing Word documents", () => {
  test("a .docx becomes a new document with its structure", async () => {
    const response = await upload("Budget 2026.docx", docx);
    assert.equal(response.status, 201);
    const { document } = (await response.json()) as { document: { meta: { id: string; title: string } } };
    assert.equal(document.meta.title, "Budget");
    const live = (await hub.get(document.meta.id))!;
    const { docToMarkdown } = await import("@/lib/doc/markdown");
    const markdown = docToMarkdown(live.doc);
    assert.match(markdown, /# Budget \{\.title\}\n\n## Costs\n\n- Rent\n- Staff/);
    assert.match(markdown, /\| Rent \| 1200 \|/);
  });

  test("other files and broken Word files are refused with a clear message", async () => {
    assert.equal((await upload("notes.doc", "old binary")).status, 415);
    const broken = await upload("broken.docx", "this is not a zip");
    assert.equal(broken.status, 422);
    assert.match(((await broken.json()) as { error: string }).error, /couldn't be read as a Word document/);
  });
});

describe("folders inside an archive", () => {
  test("Takeout's wrapper and a single top folder are dropped; the rest become folders", async () => {
    const { archiveFolders } = await import("@/lib/server/unzip");
    assert.deepEqual([...archiveFolders(["Takeout/Drive/Work/Q3/a.docx", "Takeout/Drive/b.docx"]).values()], [["Work", "Q3"], []]);
    assert.deepEqual([...archiveFolders(["export/School/a.docx", "export/b.docx"]).values()], [["School"], []]);
    assert.deepEqual([...archiveFolders(["a.docx", "Notes/b.docx"]).values()], [[], ["Notes"]]);
  });
});

describe("importing a ZIP of Word documents (Google Takeout)", () => {
  type ArchiveResult = { documents: { id: string; title: string }[]; failed: { name: string; error: string }[]; error?: string };

  test("every .docx in the archive becomes a document; other files are skipped and broken ones reported", async () => {
    const { createZip } = await import("@/lib/doc/zip");
    const untitled = createZip([{ name: "word/document.xml", data: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>' }]);
    const archive = createZip([
      { name: "Takeout/archive_browser.html", data: "<html></html>" },
      { name: "Takeout/Drive/Projects/Budget.docx", data: docx },
      { name: "Takeout/Drive/Trip notes.docx", data: untitled },
      { name: "Takeout/Drive/Broken.docx", data: "not a zip" },
      { name: "Takeout/Drive/photo.jpg", data: "jpeg bytes" },
    ]);
    const response = await upload("takeout-20261007T000000Z-001.zip", archive);
    assert.equal(response.status, 201);
    const result = (await response.json()) as ArchiveResult;
    assert.deepEqual(result.documents.map((doc) => doc.title).sort(), ["Budget", "Trip notes"]);
    assert.deepEqual(result.failed.map((item) => item.name), ["Takeout/Drive/Broken.docx"]);
    assert.match(result.failed[0]!.error, /couldn't be read as a Word document/);
    // Drive's folders come along: Budget sat in Projects.
    const budget = result.documents.find((doc) => doc.title === "Budget") as { folderId?: string };
    const { listFolders } = await import("@/lib/server/folders");
    assert.equal((await listFolders()).find((folder) => folder.id === budget.folderId)?.name, "Projects");
    assert.equal((result.documents.find((doc) => doc.title === "Trip notes") as { folderId?: string }).folderId, undefined);
    const { docToMarkdown } = await import("@/lib/doc/markdown");
    const notes = result.documents.find((doc) => doc.title === "Trip notes")!;
    assert.equal(docToMarkdown((await hub.get(notes.id))!.doc).trim(), "Hello");
  });

  test("archives without readable Word files are refused with a clear message", async () => {
    const { createZip } = await import("@/lib/doc/zip");
    const empty = await upload("photos.zip", createZip([{ name: "a.jpg", data: "x" }]));
    assert.equal(empty.status, 422);
    assert.match(((await empty.json()) as ArchiveResult).error!, /No Word \(\.docx\) files/);
    const allBroken = await upload("bad.zip", createZip([{ name: "a.docx", data: "x" }]));
    assert.equal(allBroken.status, 422);
    assert.equal(((await allBroken.json()) as ArchiveResult).failed.length, 1);
    assert.equal((await upload("fake.zip", "not a zip")).status, 422);
  });
});

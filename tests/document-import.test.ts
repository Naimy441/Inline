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

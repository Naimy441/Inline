import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import { useTempDataDir } from "./support/mcp";

/** Folders through the real route handlers. */

useTempDataDir("inline-folders-");

type FolderJSON = { id: string; name: string; parentId: string | null; color: string };
type Meta = { id: string; title: string; folderId?: string };

let folders: typeof import("@/app/api/folders/route");
let folder: typeof import("@/app/api/folders/[id]/route");
let documents: typeof import("@/app/api/documents/route");
let documentRoute: typeof import("@/app/api/documents/[id]/route");
let duplicate: typeof import("@/app/api/documents/[id]/duplicate/route");
let backup: typeof import("@/app/api/documents/backup/route");

before(async () => {
  folders = await import("@/app/api/folders/route");
  folder = await import("@/app/api/folders/[id]/route");
  documents = await import("@/app/api/documents/route");
  documentRoute = await import("@/app/api/documents/[id]/route");
  duplicate = await import("@/app/api/documents/[id]/duplicate/route");
  backup = await import("@/app/api/documents/backup/route");
});

const url = "http://localhost:3000/api";
const send = (method: string, body?: unknown) => new Request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function makeFolder(body: Record<string, unknown>) {
  const response = await folders.POST(send("POST", body), {} as never);
  assert.equal(response.status, 201);
  return ((await response.json()) as { folder: FolderJSON }).folder;
}

async function makeDocument(body: Record<string, unknown>) {
  const response = await documents.POST(send("POST", body), {} as never);
  return { status: response.status, meta: response.ok ? ((await response.json()) as { document: { meta: Meta } }).document.meta : null };
}

async function listDocuments(trashed = false) {
  const response = await documents.GET(new Request(`${url}/documents${trashed ? "?trashed=1" : ""}`), {} as never);
  return ((await response.json()) as { documents: Meta[] }).documents;
}

const moveDocument = (id: string, folderId: string | null) => documentRoute.PATCH(send("PATCH", { folderId }), params(id));

describe("folders", () => {
  test("folders nest, and documents are created in, moved between and copied within them", async () => {
    const work = await makeFolder({ name: "  Work  ", color: "blue" });
    assert.equal(work.name, "Work");
    assert.equal(work.parentId, null);
    const q3 = await makeFolder({ name: "Q3", parentId: work.id });
    assert.equal(q3.parentId, work.id);

    const { meta: plan } = await makeDocument({ title: "Plan", markdown: "Hello", folderId: q3.id });
    assert.equal(plan!.folderId, q3.id);
    assert.equal((await makeDocument({ title: "Lost", folderId: "nope" })).status, 404);

    assert.equal((await moveDocument(plan!.id, work.id)).status, 200);
    assert.equal((await listDocuments()).find((doc) => doc.id === plan!.id)!.folderId, work.id);
    assert.equal((await moveDocument(plan!.id, "missing")).status, 404);

    const copy = ((await (await duplicate.POST(send("POST"), params(plan!.id))).json()) as { document: { meta: Meta } }).document.meta;
    assert.equal(copy.folderId, work.id);

    assert.equal((await moveDocument(plan!.id, null)).status, 200);
    assert.equal((await listDocuments()).find((doc) => doc.id === plan!.id)!.folderId, undefined);

    const listed = ((await (await folders.GET(new Request(`${url}/folders`), {} as never)).json()) as { folders: FolderJSON[] }).folders;
    assert.deepEqual(listed.map((item) => item.name).sort(), ["Q3", "Work"]);
  });

  test("renaming, recoloring and moving folders; a folder can't move inside itself", async () => {
    const a = await makeFolder({ name: "A" });
    const b = await makeFolder({ name: "B", parentId: a.id });
    const renamed = await folder.PATCH(send("PATCH", { name: "Alpha", color: "rose" }), params(a.id));
    const updated = ((await renamed.json()) as { folder: FolderJSON }).folder;
    assert.equal(updated.name, "Alpha");
    assert.equal(updated.color, "rose");
    const loop = await folder.PATCH(send("PATCH", { parentId: b.id }), params(a.id));
    assert.equal(loop.status, 422);
    assert.match(((await loop.json()) as { error: string }).error, /can't move into itself/);
    assert.equal((await folder.PATCH(send("PATCH", { parentId: null }), params(b.id))).status, 200);
    assert.equal((await folder.PATCH(send("PATCH", { name: "x" }), params("missing"))).status, 404);
    assert.equal((await folders.POST(send("POST", { name: "Bad", color: "plaid" }), {} as never)).status, 400);
  });

  test("deleting a folder moves what was inside, trashed documents too, up to its parent", async () => {
    const outer = await makeFolder({ name: "Outer" });
    const inner = await makeFolder({ name: "Inner", parentId: outer.id });
    const nested = await makeFolder({ name: "Nested", parentId: inner.id });
    const { meta: kept } = await makeDocument({ title: "Kept", folderId: inner.id });
    const { meta: binned } = await makeDocument({ title: "Binned", folderId: inner.id });
    await documentRoute.PATCH(send("PATCH", { trashed: true }), params(binned!.id));

    const response = await folder.DELETE(send("DELETE"), params(inner.id));
    assert.deepEqual(await response.json(), { moved: 2, parentId: outer.id });
    assert.equal((await listDocuments()).find((doc) => doc.id === kept!.id)!.folderId, outer.id);
    assert.equal((await listDocuments(true)).find((doc) => doc.id === binned!.id)!.folderId, outer.id);
    const listed = ((await (await folders.GET(new Request(url), {} as never)).json()) as { folders: FolderJSON[] }).folders;
    assert.equal(listed.some((item) => item.id === inner.id), false);
    assert.equal(listed.find((item) => item.id === nested.id)!.parentId, outer.id);
  });

  test("the backup ZIP files Markdown copies in matching folders and keeps the folder list", async () => {
    const trips = await makeFolder({ name: "Trips: 2026" });
    const lisbon = await makeFolder({ name: "Lisbon", parentId: trips.id });
    await makeDocument({ title: "Itinerary", markdown: "Day one.", folderId: lisbon.id });
    const { readZip } = await import("@/lib/server/unzip");
    const files = readZip(new Uint8Array(await (await backup.GET(new Request(url), {} as never)).arrayBuffer()));
    assert.ok(files.has("Trips- 2026/Lisbon/Itinerary.md"), [...files.keys()].join(", "));
    const stored = JSON.parse(new TextDecoder().decode(files.get("inline-data/folders.json"))) as { folders: FolderJSON[] };
    assert.ok(stored.folders.some((item) => item.name === "Lisbon"));
  });
});

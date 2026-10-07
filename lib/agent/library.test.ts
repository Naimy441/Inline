import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { runTool, type ToolContext } from "@/lib/agent/tools";
import { documentHub } from "@/lib/server/hub";
import { listFolders } from "@/lib/server/folders";

process.env.INLINE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "inline-library-"));

const ctx: ToolContext = { author: "chat-test" };

async function make(title: string, body: string) {
  return documentHub().create({ title, markdown: `# ${title} {.title}\n\n${body}` });
}

describe("organizing the library", () => {
  test("list_library shows titles with capped excerpts, and pages through large libraries", async () => {
    const long = await make("Lisbon trip", "Day one we walked from Alfama to Belém along the river, stopping for pastries and coffee at every corner we could find along the way there.");
    await make("Q3 budget", "Revenue grew eight percent.");
    const listing = (await runTool("list_library", { excerpt_words: 5 }, ctx)).text;
    assert.match(listing, /^Folders:\nNo folders yet\./);
    assert.match(listing, new RegExp(`${long.id} · "Lisbon trip" · unfiled · \\d+ words · "Lisbon trip Day one we…"`));
    assert.doesNotMatch(listing, /Alfama to Belém/);

    const titlesOnly = (await runTool("list_library", { excerpt_words: 0 }, ctx)).text;
    assert.doesNotMatch(titlesOnly, /Revenue/);

    const first = (await runTool("list_library", { limit: 1 }, ctx)).text;
    assert.match(first, /showing 1–1/);
    assert.match(first, /Call again with offset 1/);
    const second = (await runTool("list_library", { limit: 1, offset: 1 }, ctx)).text;
    assert.doesNotMatch(second, /Folders:/);
    assert.match(second, /showing 2–2/);
  });

  test("move_documents files documents by folder path, creating folders with their own colors", async () => {
    const plan = await make("Hiring plan", "Roles to fill.");
    const notes = await make("Standup notes", "Monday.");
    const trip = await make("Packing list", "Socks.");
    const result = await runTool(
      "move_documents",
      {
        moves: [
          { document_id: plan.id, folder: "Work/Planning" },
          { document_id: notes.id, folder: "work" },
          { document_id: trip.id, folder: "Personal" },
        ],
      },
      ctx,
    );
    assert.ok(!result.isError);
    assert.match(result.text, /Moved 3 documents/);
    assert.match(result.text, /Created folders: "Work" .*"Work\/Planning" .*"Personal"/);
    const folders = await listFolders();
    const work = folders.find((folder) => folder.name === "Work")!;
    const planning = folders.find((folder) => folder.name === "Planning")!;
    const personal = folders.find((folder) => folder.name === "Personal")!;
    assert.equal(planning.parentId, work.id);
    assert.equal(planning.color, work.color, "a subfolder takes its parent's color");
    assert.notEqual(personal.color, work.color, "top-level folders get different colors");
    assert.equal(plan.meta.folderId, planning.id);
    assert.equal(notes.meta.folderId, work.id, "paths match existing folders regardless of case");

    const again = await runTool("move_documents", { moves: [{ document_id: plan.id, folder: planning.id }] }, ctx);
    assert.match(again.text, /No documents moved\.\n1 already in place\./);

    const tree = (await runTool("list_folders", {}, ctx)).text;
    assert.match(tree, /- Work \(id \w+, \w+, 1 here, 2 in all\)\n {2}- Planning \(id \w+, \w+, 1 doc\)/);
    const inWork = (await runTool("list_library", { folder: "Work" }, ctx)).text;
    assert.match(inWork, /2 in "Work" documents/);
    assert.match(inWork, /in Work\/Planning/);
  });

  test("the open document is the default, tabs move with their document, and unknown folders are refused without create_missing", async () => {
    const doc = await make("Essay", "Draft.");
    const tab = await documentHub().createTab(doc.id, { title: "Notes" });
    const moved = await runTool("move_documents", { moves: [{ folder: "School" }] }, { ...ctx, documentId: tab.id });
    assert.match(moved.text, /Moved 1 document:\n- School: "Essay"/);
    assert.equal((await listFolders()).find((folder) => folder.id === doc.meta.folderId)?.name, "School");

    const refused = await runTool("move_documents", { moves: [{ document_id: doc.id, folder: "Nowhere" }], create_missing: false }, ctx);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /There is no folder "Nowhere"/);
    const missing = await runTool("move_documents", { moves: [{ document_id: "nope", folder: "" }] }, ctx);
    assert.equal(missing.isError, true);
    assert.match(missing.text, /nope: not found/);
  });

  test("folders can be created, renamed, recolored, nested and deleted, which trashes their documents", async () => {
    assert.match((await runTool("create_folder", { name: "Archive", color: "teal" }, ctx)).text, /Created the folder "Archive"/);
    assert.match((await runTool("create_folder", { name: "2025", parent: "Archive" }, ctx)).text, /"Archive\/2025"/);
    const old = await make("Old report", "Numbers.");
    await runTool("move_documents", { moves: [{ document_id: old.id, folder: "Archive/2025" }] }, ctx);
    assert.match((await runTool("update_folder", { folder: "Archive/2025", name: "Last year", color: "rose" }, ctx)).text, /now "Archive\/Last year" \(rose\)/);
    assert.match((await runTool("update_folder", { folder: "Archive/Last year", parent: "" }, ctx)).text, /now "Last year"/);
    const loop = await runTool("update_folder", { folder: "Archive", parent: "Archive" }, ctx);
    assert.equal(loop.isError, true);
    const deleted = await runTool("delete_folder", { folder: "Archive" }, ctx);
    assert.match(deleted.text, /Deleted the folder "Archive"\. 0 documents moved to the trash/);
    const lastYear = await runTool("delete_folder", { folder: "Last year" }, ctx);
    assert.match(lastYear.text, /Deleted the folder "Last year"\. 1 document moved to the trash, where the user can restore them\./);
    assert.ok(old.meta.trashedAt);
    assert.equal((await runTool("delete_folder", { folder: "Gone" }, ctx)).isError, true);
  });

  test("create_document can file the new document, and Ask mode refuses folder changes", async () => {
    const created = await runTool("create_document", { title: "Ideas", folder: "Inbox", open: false }, ctx);
    assert.match(created.text, /Created "Ideas"/);
    const list = (await runTool("list_documents", {}, ctx)).text;
    assert.match(list, /"Ideas" · in Inbox/);
    const asked = await runTool("move_documents", { moves: [{ document_id: "x", folder: "" }] }, { ...ctx, readOnly: true });
    assert.equal(asked.isError, true);
    assert.match(asked.text, /Ask mode/);
  });
});

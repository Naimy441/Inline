import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, describe, test } from "node:test";

import { useTempDataDir } from "./support/mcp";

/** The Word copies kept in a folder on disk. */

useTempDataDir("inline-mirror-data-");
const root = mkdtempSync(path.join(tmpdir(), "inline-mirror-out-"));
process.env.INLINE_MIRROR_DIR = root;

let hubModule: typeof import("@/lib/server/hub");
let folders: typeof import("@/lib/server/folders");
let mirrorModule: typeof import("@/lib/server/mirror");
let readZip: typeof import("@/lib/server/unzip").readZip;
let runTool: typeof import("@/lib/agent/tools").runTool;

before(async () => {
  hubModule = await import("@/lib/server/hub");
  folders = await import("@/lib/server/folders");
  mirrorModule = await import("@/lib/server/mirror");
  readZip = (await import("@/lib/server/unzip")).readZip;
  runTool = (await import("@/lib/agent/tools")).runTool;
});

const hub = new Proxy({} as ReturnType<typeof import("@/lib/server/hub").documentHub>, { get: (_target, key) => Reflect.get(hubModule.documentHub(), key, hubModule.documentHub()) });
const sync = () => mirrorModule.mirror().sync();
const createFolder: typeof import("@/lib/server/folders").createFolder = (input) => folders.createFolder(input);
const ensureFolderPath: typeof import("@/lib/server/folders").ensureFolderPath = (names, options) => folders.ensureFolderPath(names, options);
const updateFolder: typeof import("@/lib/server/folders").updateFolder = (id, patch) => folders.updateFolder(id, patch);
const deleteFolder: typeof import("@/lib/server/folders").deleteFolder = (id) => folders.deleteFolder(id);
const TRASH_FOLDER = "Inline Trash";
const file = (...parts: string[]) => path.join(root, ...parts);
const docxText = (target: string) => new TextDecoder().decode(readZip(new Uint8Array(readFileSync(target))).get("word/document.xml"));

describe("Word copies on disk", () => {
  test("every document is a .docx in the same folders, with its page setup, header and footer", async () => {
    const { folder: q3 } = await ensureFolderPath(["Work", "Q3"]);
    const plan = await hub.create({ title: "Plan", markdown: "# Plan {.title}\n\nShip the thing.", folderId: q3!.id });
    plan.updateMeta({ settings: { pageSetup: { margins: { top: 1.5, right: 1, bottom: 1, left: 2 } }, headerFooter: { header: "Acme confidential" } } });
    await hub.create({ title: "Loose notes", markdown: "Top level." });
    await sync();
    const target = file("Work", "Q3", "Plan.docx");
    assert.ok(existsSync(target), readdirSync(root, { recursive: true }).join(", "));
    assert.ok(existsSync(file("Loose notes.docx")));
    const parts = readZip(new Uint8Array(readFileSync(target)));
    assert.match(docxText(target), /Ship the thing\./);
    assert.match(docxText(target), /w:pgMar w:top="2160" w:right="1440" w:bottom="1440" w:left="2880"/);
    assert.match(new TextDecoder().decode(parts.get("word/header1.xml")), /Acme confidential/);
  });

  test("edits rewrite the file; opening a document without changing it doesn't", async () => {
    const doc = await hub.create({ title: "Draft", markdown: "First version." });
    await sync();
    const target = file("Draft.docx");
    const before = statSync(target).mtimeMs;
    doc.touch();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await sync();
    assert.equal(statSync(target).mtimeMs, before, "unchanged documents aren't rewritten");
    await runTool("write_document", { content: "Second version." }, { author: "test", documentId: doc.id });
    await sync();
    assert.match(docxText(target), /Second version\./);
  });

  test("renaming, moving and folder renames move the file and tidy empty folders", async () => {
    const school = await createFolder({ name: "School" });
    const essay = await hub.create({ title: "Essay", markdown: "Words.", folderId: school.id });
    await sync();
    assert.ok(existsSync(file("School", "Essay.docx")));
    essay.updateMeta({ title: "History essay" });
    await sync();
    assert.ok(!existsSync(file("School", "Essay.docx")));
    assert.ok(existsSync(file("School", "History essay.docx")));
    await updateFolder(school.id, { name: "University" });
    await sync();
    assert.ok(existsSync(file("University", "History essay.docx")));
    assert.ok(!existsSync(file("School")), "the emptied folder is removed");
    essay.setFolder(null);
    await sync();
    assert.ok(existsSync(file("History essay.docx")));
    assert.ok(existsSync(file("University")), "the folder is still in Inline, so it stays on disk, empty");
    assert.equal(readdirSync(file("University")).length, 0);
  });

  test("empty folders exist on disk, and deleted ones are removed", async () => {
    const { folder } = await ensureFolderPath(["Ideas", "Someday"]);
    await sync();
    assert.ok(existsSync(file("Ideas", "Someday")));
    await deleteFolder(folder!.id);
    await sync();
    assert.ok(!existsSync(file("Ideas", "Someday")));
    assert.ok(existsSync(file("Ideas")));
  });

  test("Download all and locate use the same names as the folder on disk", async () => {
    const entries = await mirrorModule.mirror().tree();
    const names = entries.map((entry) => entry.name);
    assert.ok(names.includes("Work/Q3/Plan.docx"));
    const plan = (await hubModule.documentHub().list()).find((meta) => meta.title === "Plan")!;
    assert.deepEqual(await mirrorModule.mirror().locate({ documentId: plan.id }), { path: file("Work", "Q3", "Plan.docx"), isFile: true });
    const work = (await folders.listFolders()).find((item) => item.name === "Work")!;
    assert.deepEqual(await mirrorModule.mirror().locate({ folderId: work.id }), { path: file("Work"), isFile: false });
    assert.deepEqual(await mirrorModule.mirror().locate({}), { path: root, isFile: false });
  });

  test("namesakes get numbers, and Inline never overwrites a file it didn't write", async () => {
    mkdirSync(file("Mine"), { recursive: true });
    writeFileSync(file("Mine", "Notes.docx"), "the user's own file");
    const mine = await createFolder({ name: "Mine" });
    const first = await hub.create({ title: "Notes", markdown: "One.", folderId: mine.id });
    await hub.create({ title: "Notes", markdown: "Two.", folderId: mine.id });
    await sync();
    assert.equal(readFileSync(file("Mine", "Notes.docx"), "utf8"), "the user's own file");
    assert.ok(existsSync(file("Mine", "Notes (2).docx")));
    assert.ok(existsSync(file("Mine", "Notes (3).docx")));
    assert.match(docxText(file("Mine", "Notes (2).docx")), /One\./, "the older document keeps the lower number");
    // Renaming the first away doesn't make the second one jump names.
    first.updateMeta({ title: "Other notes" });
    await sync();
    assert.ok(existsSync(file("Mine", "Other notes.docx")));
    assert.ok(existsSync(file("Mine", "Notes (3).docx")));
  });

  test("trashed documents move to the trash folder; deleting them for good removes the file", async () => {
    const { folder } = await ensureFolderPath(["Old"]);
    const doc = await hub.create({ title: "Scrap", markdown: "Bye.", folderId: folder!.id });
    await sync();
    doc.setTrashed(true);
    await sync();
    assert.ok(!existsSync(file("Old", "Scrap.docx")));
    assert.ok(existsSync(file(TRASH_FOLDER, "Old", "Scrap.docx")));
    await hub.remove(doc.id);
    await sync();
    assert.ok(!existsSync(file(TRASH_FOLDER, "Old", "Scrap.docx")));
  });

  test("deleting a folder trashes its documents on disk too", async () => {
    const box = await createFolder({ name: "Box" });
    await hub.create({ title: "Inside", markdown: "x", folderId: box.id });
    await sync();
    await deleteFolder(box.id);
    await sync();
    assert.ok(existsSync(file(TRASH_FOLDER, "Inside.docx")));
    assert.ok(!existsSync(file("Box")));
  });

  test("every tab goes into the one file", async () => {
    const doc = await hub.create({ title: "Handbook", markdown: "Chapter one text." });
    const tab = await hub.createTab(doc.id, { title: "Appendix", markdown: "Appendix text." });
    await sync();
    const text = docxText(file("Handbook.docx"));
    assert.match(text, /Chapter one text\./);
    assert.match(text, /Appendix text\./);
    await runTool("write_document", { content: "Revised appendix." }, { author: "test", documentId: tab.id });
    await sync();
    assert.match(docxText(file("Handbook.docx")), /Revised appendix\./);
    // Each tab is a section headed by its name, as Google Docs writes tabs, so the file reads back with its tabs.
    const { readDocx } = await import("@/lib/doc/docxImport");
    const back = await readDocx(readZip(new Uint8Array(readFileSync(file("Handbook.docx")))));
    assert.deepEqual(back.tabs.map((item) => item.title), ["Tab 1", "Appendix"]);
    assert.deepEqual(back.tabs.map((item) => item.doc.textContent), ["Chapter one text.", "Revised appendix."]);
  });

  test("comments are in the Word copy, and replying or resolving updates it", async () => {
    const doc = await hub.create({ title: "Reviewed", markdown: "Please check this sentence." });
    const comment = doc.addComment({ from: 14, to: 27, body: "Is this right?", author: "user" }, { kind: "system", label: "test" });
    await doc.flush();
    await sync();
    const commentsXml = () => new TextDecoder().decode(readZip(new Uint8Array(readFileSync(file("Reviewed.docx")))).get("word/comments.xml"));
    assert.match(docxText(file("Reviewed.docx")), /<w:commentRangeStart w:id="0"\/>.*this sentence.*<w:commentRangeEnd w:id="0"\/>/);
    assert.match(commentsXml(), /Is this right\?/);
    doc.replyToComment(comment.id, "Yes, it is.", "claude");
    doc.setCommentResolved(comment.id, true);
    await doc.flush();
    await sync();
    assert.match(commentsXml(), /w:author="Claude"[^>]*>.*Yes, it is\./);
    const { readDocx } = await import("@/lib/doc/docxImport");
    const [thread] = (await readDocx(readZip(new Uint8Array(readFileSync(file("Reviewed.docx")))))).tabs[0]!.comments;
    assert.deepEqual([thread!.body, thread!.quote, thread!.resolved, thread!.replies.map((reply) => [reply.author, reply.body])], ["Is this right?", "this sentence", true, [["claude", "Yes, it is."]]]);
  });

  test("a Google Doc imported from Takeout has a Word copy that reads back as the same document", async () => {
    const google = await import("./support/googleDocx");
    const route = await import("@/app/api/documents/import/route");
    const takeout = google.googleDocx(
      [
        google.tabTitle("Draft"),
        google.para("Chapter One", { style: "Heading1" }),
        google.para([google.run("It was "), google.commentStart(0), google.run("dark", '<w:b w:val="1"/>'), google.commentEnd(0), google.run(" out.")], { ind: 'w:firstLine="720"', spacing: 'w:line="480" w:lineRule="auto"' }),
        google.para("Pack bags", { list: { id: google.LIST.bullet } }),
        google.para("Leave", { list: { id: google.LIST.decimal } }),
        google.table([[{ text: "Day", fill: "fce5cd" }, { text: "Miles" }], [{ text: "Monday" }, { text: "12" }]]),
        google.horizontalRule(),
        google.tabEnd("The end."),
        google.tabTitle("Notes"),
        google.para("Ideas for later."),
      ],
      { comments: [{ id: 0, author: "Editor", date: "2024-05-01T10:00:00Z", text: "Too vague" }], header: { text: "Smith {page}", align: "right" }, margins: { top: 720, right: 720, bottom: 720, left: 720 } },
    );
    const { createZip } = await import("@/lib/doc/zip");
    const form = new FormData();
    form.append("file", new File([Buffer.from(createZip([{ name: "Takeout/Drive/Stories/Night Walk.docx", data: takeout }]))], "takeout.zip"));
    const response = await route.POST(new Request("http://localhost:3000/api/documents/import", { method: "POST", body: form }), {} as never);
    assert.equal(response.status, 201);
    const { documents } = (await response.json()) as { documents: { id: string }[] };
    await sync();
    const target = file("Stories", "Night Walk.docx");
    assert.ok(existsSync(target), readdirSync(root, { recursive: true }).join(", "));

    const { readDocx } = await import("@/lib/doc/docxImport");
    const back = await readDocx(readZip(new Uint8Array(readFileSync(target))));
    const { tabs } = await hub.family(documents[0]!.id);
    const root0 = tabs[0]!;
    assert.deepEqual(back.settings, root0.meta.settings, "page setup, fonts, spacing and header");
    assert.equal(root0.meta.settings.headerFooter.header, "Smith {page}");
    assert.deepEqual(back.tabs.map((tab) => tab.title), ["Draft", "Notes"]);
    tabs.forEach((tab, index) => {
      assert.deepEqual(google.comparable(back.tabs[index]!.doc), google.comparable(tab.doc), `tab ${index + 1}`);
      assert.deepEqual(back.tabs[index]!.comments.map((c) => [c.body, c.quote]), tab.snapshot().comments.map((c) => [c.body, c.quote]));
    });
    assert.deepEqual(tabs[0]!.snapshot().comments.map((c) => c.body), ["Editor: Too vague"]);
  });

  test("status reports the folder and how many files it holds", async () => {
    const status = await mirrorModule.mirror().getStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.dir, root);
    assert.equal(status.source, "env");
    assert.equal(status.state, "idle");
    assert.ok(status.files > 5);
  });
});

describe("planning file names", () => {
  test("unsafe characters and reserved names are made safe", () => {
    const meta = (id: string, title: string) => ({ id, title, createdAt: 1, updatedAt: 1, lastOpenedAt: 1, trashedAt: null, wordCount: 0, preview: "", settings: {} as never });
    const plan = mirrorModule.plannedPaths([meta("a", "Q3: plan / draft?"), meta("b", "CON"), meta("c", "  ...  ")], new Map());
    assert.equal(plan.get("a"), "Q3- plan - draft-.docx");
    assert.equal(plan.get("b"), "Untitled document.docx");
    assert.equal(plan.get("c"), "Untitled document (2).docx");
  });
});

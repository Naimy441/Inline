import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import { BUILTIN_COMMANDS, expandSlashCommand, matchCommands, mergeCommands } from "@/lib/agent/commands";
import { useTempDataDir } from "./support/mcp";

/** Slash commands (pure helpers and the settings route) and locking text through the route. */

useTempDataDir("inline-commands-");

describe("slash command helpers", () => {
  const commands = mergeCommands([{ name: "proofread", description: "Mine", prompt: "My proofread." }, { name: "brief", description: "Make it brief", prompt: "Be brief." }]);

  test("custom commands come first and override built-ins by name", () => {
    assert.equal(commands[0]!.name, "proofread");
    assert.equal(commands[0]!.prompt, "My proofread.");
    assert.equal(commands[0]!.builtin, false);
    assert.equal(commands.filter((command) => command.name === "proofread").length, 1);
    assert.equal(commands.length, BUILTIN_COMMANDS.length + 1);
  });

  test("expands a command with extra instructions, leaves other text alone", () => {
    assert.equal(expandSlashCommand("/brief", commands), "Be brief.");
    assert.equal(expandSlashCommand("  /BRIEF only the intro ", commands), "Be brief.\n\nonly the intro");
    assert.equal(expandSlashCommand("/unknown thing", commands), "/unknown thing");
    assert.equal(expandSlashCommand("please /brief", commands), "please /brief");
  });

  test("matches prefixes before other matches", () => {
    const names = matchCommands("co", commands).map((command) => command.name);
    assert.deepEqual(names.slice(0, 2).sort(), ["comments", "continue"]);
    assert.ok(matchCommands("repetition", commands).some((command) => command.name === "tighten"));
    assert.equal(matchCommands("", commands).length, commands.length);
  });
});

describe("commands route", () => {
  let route: typeof import("@/app/api/agent/commands/route");
  before(async () => {
    route = await import("@/app/api/agent/commands/route");
  });

  const put = (body: unknown) =>
    route.PUT(new Request("http://localhost:3000/api/agent/commands", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), {} as never);

  test("starts with the built-ins, saves custom commands and dedupes names", async () => {
    const initial = (await (await route.GET(new Request("http://localhost:3000/api/agent/commands"), {} as never)).json()) as { commands: unknown[] };
    assert.equal(initial.commands.length, BUILTIN_COMMANDS.length);
    const response = await put({ commands: [{ name: "brief", description: "", prompt: "Be brief." }, { name: "brief", description: "", prompt: "Dup." }] });
    assert.equal(response.status, 200);
    const after = (await (await route.GET(new Request("http://localhost:3000/api/agent/commands"), {} as never)).json()) as { commands: { name: string; prompt: string }[] };
    assert.equal(after.commands.filter((command) => command.name === "brief").length, 1);
    assert.equal(after.commands.find((command) => command.name === "brief")!.prompt, "Be brief.");
  });

  test("rejects bad names and empty prompts", async () => {
    assert.equal((await put({ commands: [{ name: "Bad Name", description: "", prompt: "x" }] })).status, 400);
    assert.equal((await put({ commands: [{ name: "ok", description: "", prompt: "  " }] })).status, 400);
  });
});

describe("lock route", () => {
  let route: typeof import("@/app/api/documents/[id]/lock/route");
  let hub: ReturnType<typeof import("@/lib/server/hub").documentHub>;
  before(async () => {
    route = await import("@/app/api/documents/[id]/lock/route");
    hub = (await import("@/lib/server/hub")).documentHub();
  });

  const lock = (id: string, body: unknown) =>
    route.POST(new Request(`http://localhost:3000/api/documents/${id}/lock`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id }) });

  test("locks and unlocks a range without creating a pending change", async () => {
    const doc = await hub.create({ markdown: "Keep this sentence exactly." });
    const locked = await lock(doc.id, { from: 1, to: 10, version: doc.version, locked: true });
    assert.equal(locked.status, 200);
    assert.equal(doc.lockedRanges().length, 1);
    assert.equal(doc.hunks.length, 0);
    const unlocked = await lock(doc.id, { from: 1, to: 10, version: doc.version, locked: false });
    assert.equal(((await unlocked.json()) as { changed: boolean }).changed, true);
    assert.equal(doc.lockedRanges().length, 0);
  });

  test("rejects a stale version and a bad range", async () => {
    const doc = await hub.create({ markdown: "Hello." });
    assert.equal((await lock(doc.id, { from: 1, to: 3, version: doc.version + 5, locked: true })).status, 409);
    assert.equal((await lock(doc.id, { from: 3, to: 3, version: doc.version, locked: true })).status, 400);
    assert.equal((await lock(doc.id, { from: 1, to: 9999, version: doc.version, locked: true })).status, 400);
  });
});

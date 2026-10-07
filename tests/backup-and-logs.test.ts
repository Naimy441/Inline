import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { before, describe, test } from "node:test";

import { useTempDataDir } from "./support/mcp";

/** Whole-library backups, the MCP token, and the server log behind "something went wrong". */

const dataDir = useTempDataDir("inline-backup-");

let hub: ReturnType<typeof import("@/lib/server/hub").documentHub>;
before(async () => {
  hub = (await import("@/lib/server/hub")).documentHub();
});

describe("backup", () => {
  test("downloads every document as a Word file, namesakes numbered and trash in its own folder", async () => {
    await hub.create({ title: "Plan", markdown: "# Plan\n\nShip it." });
    await hub.create({ title: "Plan", markdown: "Second plan." });
    const c = await hub.create({ title: "Old/notes", markdown: "Gone soon." });
    c.setTrashed(true);
    const route = await import("@/app/api/documents/backup/route");
    const response = await route.GET(new Request("http://localhost:3000/api/documents/backup"), {} as never);
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.match(response.headers.get("content-disposition")!, /Inline documents \d{4}-\d{2}-\d{2}\.zip/);
    const { readZip } = await import("@/lib/server/unzip");
    const files = readZip(new Uint8Array(await response.arrayBuffer()));
    const names = [...files.keys()];
    assert.ok(names.includes("Plan.docx") && names.includes("Plan (2).docx"), names.join(", "));
    assert.ok(names.includes("Inline Trash/Old-notes.docx"));
    const text = (name: string) => new TextDecoder().decode(readZip(files.get(name)!).get("word/document.xml"));
    assert.match(text("Plan.docx"), /Ship it\./);
    assert.match(text("Plan (2).docx"), /Second plan\./);
  });
});

describe("MCP token", () => {
  test("is generated once, kept in the data folder, and checked on requests", async () => {
    const { mcpToken, mcpAuthorized } = await import("@/lib/server/mcpToken");
    const token = (await mcpToken())!;
    assert.ok(token.length >= 24);
    assert.equal(await mcpToken(), token);
    assert.equal(readFileSync(path.join(dataDir, "mcp-token"), "utf8").trim(), token);
    const request = (auth?: string) => new Request("http://localhost/api/mcp", { method: "POST", headers: auth ? { authorization: auth } : {} });
    assert.equal(await mcpAuthorized(request()), false);
    assert.equal(await mcpAuthorized(request("Bearer nope")), false);
    assert.equal(await mcpAuthorized(request(`Bearer ${token}`)), true);
    process.env.INLINE_MCP_TOKEN = "off";
    try {
      assert.equal(await mcpAuthorized(request()), true);
    } finally {
      delete process.env.INLINE_MCP_TOKEN;
    }
  });

  test("the connect route returns the command with the token", async () => {
    const route = await import("@/app/api/mcp/connect/route");
    const body = (await (await route.GET(new Request("http://localhost:3000/api/mcp/connect"), {} as never)).json()) as { command: string; token: string };
    assert.equal(body.command, `claude mcp add --transport http inline http://localhost:3000/api/mcp --header "Authorization: Bearer ${body.token}"`);
  });
});

describe("server errors", () => {
  test("an unexpected error returns a reference id that matches a line in the log file", async () => {
    const { route } = await import("@/lib/server/http");
    const { flushLog } = await import("@/lib/server/log");
    const original = console.error;
    console.error = () => undefined;
    try {
      const handler = route(async () => {
        throw new Error("disk on fire");
      });
      const response = await handler(new Request("http://localhost:3000/api/thing", { method: "POST" }), {});
      assert.equal(response.status, 500);
      const body = (await response.json()) as { error: string; reference: string };
      assert.match(body.error, new RegExp(`reference ${body.reference}`));
      assert.doesNotMatch(body.error, /disk on fire/, "internal details stay out of the response");
      await flushLog();
      const lines = readFileSync(path.join(dataDir, "logs", "inline.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      const entry = lines.find((line) => line.reference === body.reference)!;
      assert.equal(entry.path, "/api/thing");
      assert.equal((entry.error as { message: string }).message, "disk on fire");
    } finally {
      console.error = original;
    }
  });
});

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import type { Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";

import { schema } from "@/lib/doc/schema";

import { useTempDataDir } from "./support/mcp";

/**
 * The document sync endpoints across a server restart: version numbers start
 * again at 0, so a browser tab's old version must not be mistaken for a new one.
 */

useTempDataDir("inline-doc-sync-");

type Hub = ReturnType<typeof import("@/lib/server/hub").documentHub>;
let routes: {
  events: typeof import("@/app/api/documents/[id]/events/route");
  steps: typeof import("@/app/api/documents/[id]/steps/route");
};
let hubModule: typeof import("@/lib/server/hub");

before(async () => {
  hubModule = await import("@/lib/server/hub");
  routes = {
    events: await import("@/app/api/documents/[id]/events/route"),
    steps: await import("@/app/api/documents/[id]/steps/route"),
  };
});

const BASE = "http://localhost:3000";
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Forget every loaded document, as a server restart does. */
async function restart(): Promise<Hub> {
  const hub = hubModule.documentHub();
  await hub.flushAll();
  (globalThis as unknown as { __inlineHub?: unknown }).__inlineHub = undefined;
  return hubModule.documentHub();
}

async function firstEvent(id: string, query: string) {
  const controller = new AbortController();
  const response = await routes.events.GET(new Request(`${BASE}/api/documents/${id}/events${query}`, { signal: controller.signal }), params(id));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buffer += decoder.decode(value, { stream: true });
      const match = /^data: (.*)$/m.exec(buffer);
      if (match) return JSON.parse(match[1]!) as { type: string; snapshot?: { epoch: string }; steps?: unknown[] };
    }
  } finally {
    controller.abort();
  }
}

function insertStep(doc: PMNode, text: string) {
  return new Transform(doc).insert(1, schema.text(text)).steps.map((step) => step.toJSON());
}

const postSteps = (id: string, body: unknown) =>
  routes.steps.POST(new Request(`${BASE}/api/documents/${id}/steps`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), params(id));

describe("document sync across a server restart", () => {
  test("a tab reconnecting with a version from before the restart gets a full snapshot, not a replay", async () => {
    let hub = hubModule.documentHub();
    const live = await hub.create({ markdown: "Original text." });
    const oldEpoch = live.epoch;
    live.receiveClientSteps(0, insertStep(live.doc, "A"), "tab", { epoch: oldEpoch });
    live.receiveClientSteps(1, insertStep(live.doc, "B"), "tab", { epoch: oldEpoch });

    hub = await restart();
    const reloaded = (await hub.get(live.id))!;
    assert.notEqual(reloaded.epoch, oldEpoch);
    // Someone else edits after the restart, so the version numbers overlap with the tab's.
    reloaded.receiveClientSteps(0, insertStep(reloaded.doc, "C"), "other");
    reloaded.receiveClientSteps(1, insertStep(reloaded.doc, "D"), "other");
    reloaded.receiveClientSteps(2, insertStep(reloaded.doc, "E"), "other");

    const stale = await firstEvent(live.id, `?version=2&epoch=${oldEpoch}`);
    assert.equal(stale.type, "snapshot");
    assert.equal(stale.snapshot!.epoch, reloaded.epoch);

    const current = await firstEvent(live.id, `?version=2&epoch=${reloaded.epoch}`);
    assert.equal(current.type, "steps");
    assert.equal(current.steps!.length, 1);
  });

  test("steps typed against the old load are refused with a reload signal", async () => {
    let hub = hubModule.documentHub();
    const live = await hub.create({ markdown: "Hello." });
    const oldEpoch = live.epoch;
    hub = await restart();
    const reloaded = (await hub.get(live.id))!;
    const response = await postSteps(live.id, { version: 0, steps: insertStep(reloaded.doc, "X"), clientID: "tab", epoch: oldEpoch });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { stale?: boolean; epoch?: string };
    assert.equal(body.stale, true);
    assert.equal(body.epoch, reloaded.epoch);
    assert.equal(reloaded.version, 0);

    const ok = await postSteps(live.id, { version: 0, steps: insertStep(reloaded.doc, "X"), clientID: "tab", epoch: reloaded.epoch });
    assert.equal(ok.status, 200);
  });
});

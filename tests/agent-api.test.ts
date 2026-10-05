import assert from "node:assert/strict";
import { after, before, describe, mock, test } from "node:test";

import type { ChatRuntime } from "@/lib/agent/runtime";
import type { ChatState, SequencedChatEvent } from "@/lib/agent/types";

import { FakeClaude } from "./support/fake-claude";
import { useTempDataDir } from "./support/mcp";

/**
 * The chat API the agent panel talks to (app/api/agent/**), called through
 * the real route handlers with a scripted Claude Code behind them.
 */

useTempDataDir("inline-agent-api-");
const claude = new FakeClaude();

type Routes = {
  chats: typeof import("@/app/api/agent/chats/route");
  chat: typeof import("@/app/api/agent/chats/[id]/route");
  messages: typeof import("@/app/api/agent/chats/[id]/messages/route");
  events: typeof import("@/app/api/agent/chats/[id]/events/route");
  interrupt: typeof import("@/app/api/agent/chats/[id]/interrupt/route");
  retry: typeof import("@/app/api/agent/chats/[id]/retry/route");
  queue: typeof import("@/app/api/agent/chats/[id]/queue/[queueId]/route");
  status: typeof import("@/app/api/agent/status/route");
};
let routes: Routes;
let hub: ReturnType<typeof import("@/lib/server/hub").documentHub>;
let runtime: ReturnType<typeof import("@/lib/agent/runtime").agentRuntime>;

before(async () => {
  const real = await import("@anthropic-ai/claude-agent-sdk");
  mock.module("@anthropic-ai/claude-agent-sdk", { namedExports: { ...real, query: claude.query } });
  routes = {
    chats: await import("@/app/api/agent/chats/route"),
    chat: await import("@/app/api/agent/chats/[id]/route"),
    messages: await import("@/app/api/agent/chats/[id]/messages/route"),
    events: await import("@/app/api/agent/chats/[id]/events/route"),
    interrupt: await import("@/app/api/agent/chats/[id]/interrupt/route"),
    retry: await import("@/app/api/agent/chats/[id]/retry/route"),
    queue: await import("@/app/api/agent/chats/[id]/queue/[queueId]/route"),
    status: await import("@/app/api/agent/status/route"),
  };
  hub = (await import("@/lib/server/hub")).documentHub();
  runtime = (await import("@/lib/agent/runtime")).agentRuntime();
});

after(() => {
  for (const chat of (runtime as unknown as { chats: Map<string, ChatRuntime> }).chats.values()) chat.close();
});

const BASE = "http://localhost:3000";
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
const post = (path: string, body?: unknown) =>
  new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function createChat(body: unknown = {}) {
  const response = await routes.chats.POST(post("/api/agent/chats", body), undefined as never);
  assert.equal(response.status, 201);
  return ((await response.json()) as { chat: ChatState }).chat;
}

async function getChat(id: string) {
  const response = await routes.chat.GET(new Request(`${BASE}/api/agent/chats/${id}`), params({ id }));
  return { status: response.status, body: (await response.json()) as { chat: ChatState; error?: string } };
}

async function waitIdle(id: string) {
  for (let i = 0; i < 600; i += 1) {
    const { body } = await getChat(id);
    const last = body.chat.messages.at(-1);
    if (!body.chat.running && last && last.role === "assistant" && last.status !== "streaming") return body.chat;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("turn did not finish");
}

/** Read SSE events from a streaming response until `until` returns true. */
async function readEvents(response: Response, until: (event: SequencedChatEvent) => boolean, controller: AbortController) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: SequencedChatEvent[] = [];
  let buffer = "";
  const ids: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      const id = frame.split("\n").find((line) => line.startsWith("id: "));
      if (id) ids.push(id.slice(4));
      if (!data) continue;
      const event = JSON.parse(data.slice(6)) as SequencedChatEvent;
      events.push(event);
      if (until(event)) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        return { events, ids };
      }
    }
  }
  return { events, ids };
}

describe("chat lifecycle over HTTP", () => {
  test("create, send, stream, read back, rename, delete", async () => {
    const doc = await hub.create({ title: "Essay", markdown: "Draft one." });
    const chat = await createChat({ documentId: doc.id, settings: { effort: "high", mode: "agent" } });
    assert.equal(chat.documentId, doc.id);
    assert.equal(chat.settings.effort, "high");
    assert.equal(chat.title, "New chat");

    const controller = new AbortController();
    const stream = await routes.events.GET(new Request(`${BASE}/api/agent/chats/${chat.id}/events`, { signal: controller.signal }), params({ id: chat.id }));
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    const reading = readEvents(stream, (event) => event.type === "message_done", controller);

    claude.script(async (turn) => {
      await turn.tool("mcp__inline__edit_document", { old_string: "Draft one.", new_string: "Draft two." });
      turn.say("Updated the draft.");
    });
    const sent = await routes.messages.POST(post(`/api/agent/chats/${chat.id}/messages`, { text: "Bump the draft number" }), params({ id: chat.id }));
    assert.equal(sent.status, 202);
    assert.equal(((await sent.json()) as { queued: boolean }).queued, false);

    const { events, ids } = await reading;
    assert.equal(events[0]!.type, "snapshot");
    assert.ok(events.some((event) => event.type === "change"));
    assert.equal(events.at(-1)!.type, "message_done");
    assert.ok(ids.length > 0 && ids.every((id) => /^\d+$/.test(id)), "every event carries its sequence number as the SSE id");

    const finished = await waitIdle(chat.id);
    assert.equal(finished.title, "Bump the draft number");
    const listed = (await (await routes.chats.GET(new Request(`${BASE}/api/agent/chats?documentId=${doc.id}`), undefined as never)).json()) as { chats: Array<{ id: string }> };
    assert.deepEqual(
      listed.chats.map((item) => item.id),
      [chat.id],
    );

    const renamed = await routes.chat.PATCH(new Request(`${BASE}/api/agent/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title: "Essay help" }) }), params({ id: chat.id }));
    assert.equal(((await renamed.json()) as { chat: ChatState }).chat.title, "Essay help");

    const deleted = await routes.chat.DELETE(new Request(`${BASE}/api/agent/chats/${chat.id}`, { method: "DELETE" }), params({ id: chat.id }));
    assert.equal(deleted.status, 200);
    assert.equal((await getChat(chat.id)).status, 404);
  });

  test("reconnecting with ?after= resumes without a snapshot", async () => {
    const chat = await createChat();
    await routes.messages.POST(post(`/api/agent/chats/${chat.id}/messages`, { text: "one" }), params({ id: chat.id }));
    await waitIdle(chat.id);
    const controller = new AbortController();
    const first = await routes.events.GET(new Request(`${BASE}/api/agent/chats/${chat.id}/events`, { signal: controller.signal }), params({ id: chat.id }));
    const { events } = await readEvents(first, () => true, controller);
    const seq = events[0]!.seq;

    claude.script((turn) => turn.say("two"));
    await routes.messages.POST(post(`/api/agent/chats/${chat.id}/messages`, { text: "two" }), params({ id: chat.id }));
    await waitIdle(chat.id);
    const again = new AbortController();
    const resumed = await routes.events.GET(new Request(`${BASE}/api/agent/chats/${chat.id}/events?after=${seq}`, { signal: again.signal }), params({ id: chat.id }));
    const replay = await readEvents(resumed, (event) => event.type === "message_done", again);
    assert.notEqual(replay.events[0]!.type, "snapshot");
    assert.ok(replay.events.every((event) => event.seq > seq));

    const header = new AbortController();
    const viaHeader = await routes.events.GET(new Request(`${BASE}/api/agent/chats/${chat.id}/events`, { signal: header.signal, headers: { "last-event-id": String(seq) } }), params({ id: chat.id }));
    const replayHeader = await readEvents(viaHeader, () => true, header);
    assert.notEqual(replayHeader.events[0]!.type, "snapshot");
  });

  test("queue, remove from queue, interrupt", async () => {
    const chat = await createChat();
    claude.script(async (turn) => {
      turn.say("working");
      await turn.waitForInterrupt(3000);
      turn.stopped();
    });
    await routes.messages.POST(post(`/api/agent/chats/${chat.id}/messages`, { text: "long task" }), params({ id: chat.id }));
    const queuedResponse = await routes.messages.POST(post(`/api/agent/chats/${chat.id}/messages`, { text: "later" }), params({ id: chat.id }));
    const queued = (await queuedResponse.json()) as { queued: boolean; id: string };
    assert.equal(queued.queued, true);
    const removed = await routes.queue.DELETE(new Request(`${BASE}/x`, { method: "DELETE" }), params({ id: chat.id, queueId: queued.id }));
    assert.deepEqual(((await removed.json()) as { queue: unknown[] }).queue, []);
    const interrupted = await routes.interrupt.POST(post(`/api/agent/chats/${chat.id}/interrupt`), params({ id: chat.id }));
    assert.equal(interrupted.status, 200);
    const finished = await waitIdle(chat.id);
    const last = finished.messages.at(-1)!;
    assert.equal(last.role === "assistant" && last.status, "stopped");
  });

  test("retry after an error", async () => {
    const chat = await createChat();
    claude.script(
      (turn) => turn.fail("error_during_execution", ["boom"]),
      (turn) => turn.say("fine now"),
    );
    await routes.messages.POST(post(`/api/agent/chats/${chat.id}/messages`, { text: "go" }), params({ id: chat.id }));
    await waitIdle(chat.id);
    const retried = await routes.retry.POST(post(`/api/agent/chats/${chat.id}/retry`), params({ id: chat.id }));
    assert.equal(retried.status, 202);
    const finished = await waitIdle(chat.id);
    assert.equal(finished.messages.length, 2);
    assert.equal(finished.messages[1]!.role === "assistant" && finished.messages[1]!.status, "done");
  });

  test("settings changes become the defaults for new chats", async () => {
    const chat = await createChat();
    await routes.chat.PATCH(new Request(`${BASE}/x`, { method: "PATCH", body: JSON.stringify({ settings: { mode: "ask", effort: "low" } }) }), params({ id: chat.id }));
    const next = await createChat();
    assert.equal(next.settings.mode, "ask");
    assert.equal(next.settings.effort, "low");
    await routes.chat.PATCH(new Request(`${BASE}/x`, { method: "PATCH", body: JSON.stringify({ settings: { mode: "agent", effort: "medium" } }) }), params({ id: next.id }));
  });

  test("status reports Claude Code's state and the defaults", async () => {
    const response = await routes.status.GET(new Request(`${BASE}/api/agent/status?refresh=1`), undefined as never);
    const body = (await response.json()) as { status: { state: string }; defaults: { effort: string } };
    assert.equal(body.status.state, "ready");
    assert.ok(body.defaults.effort);
  });
});

describe("request validation", () => {
  test("unknown and malformed chat ids are 404s", async () => {
    assert.equal((await getChat("does-not-exist")).status, 404);
    const bad = await routes.chat.GET(new Request(`${BASE}/x`), params({ id: "../../etc/passwd" }));
    assert.equal(bad.status, 404);
  });

  test("bad bodies are 400s with the field named", async () => {
    const chat = await createChat();
    const notJson = await routes.messages.POST(new Request(`${BASE}/x`, { method: "POST", body: "{" }), params({ id: chat.id }));
    assert.equal(notJson.status, 400);
    assert.match(((await notJson.json()) as { error: string }).error, /JSON/);
    const wrong = await routes.messages.POST(post("/x", { text: 5 }), params({ id: chat.id }));
    assert.equal(wrong.status, 400);
    assert.match(((await wrong.json()) as { error: string }).error, /text/);
    const mode = await routes.chat.PATCH(new Request(`${BASE}/x`, { method: "PATCH", body: JSON.stringify({ settings: { mode: "god" } }) }), params({ id: chat.id }));
    assert.equal(mode.status, 400);
    const extra = await routes.chat.PATCH(new Request(`${BASE}/x`, { method: "PATCH", body: JSON.stringify({ settings: { permissionMode: "bypassPermissions" } }) }), params({ id: chat.id }));
    assert.equal(extra.status, 400, "unknown settings can't be smuggled into the Claude Code session");
    const attachment = await routes.messages.POST(post("/x", { text: "hi", attachments: [{ id: "../secret", name: "x", mime: "text/plain", size: 1, kind: "text" }] }), params({ id: chat.id }));
    assert.equal(attachment.status, 400);
  });

  test("an empty message is refused", async () => {
    const chat = await createChat();
    const response = await routes.messages.POST(post("/x", { text: "  " }), params({ id: chat.id }));
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /empty/);
  });
});

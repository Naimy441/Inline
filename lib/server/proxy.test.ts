import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { NextRequest } from "next/server";

import { proxy } from "@/proxy";

/**
 * The request guard in front of /api/mcp and the rest of the API. Inline
 * drives Claude Code with the user's own login, so the MCP endpoint must not
 * be reachable from other websites (CSRF, DNS rebinding) or, when a token is
 * configured, without it.
 */

function request(url: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  const host = new URL(url).host;
  return new NextRequest(url, { method: init.method ?? "GET", headers: { host, ...init.headers } });
}

function mcpPost(url = "http://localhost:3000/api/mcp", headers: Record<string, string> = {}) {
  return request(url, { method: "POST", headers: { "content-type": "application/json", ...headers } });
}

async function status(response: Response) {
  return response.headers.get("x-middleware-next") === "1" ? "next" : response.status;
}

afterEach(() => {
  delete process.env.INLINE_ACCESS_TOKEN;
  delete process.env.INLINE_ALLOWED_HOSTS;
});

describe("host allow-list (DNS rebinding)", () => {
  for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "inline.localhost:3000"]) {
    test(`allows ${host}`, async () => {
      assert.equal(await status(proxy(mcpPost(`http://${host}/api/mcp`))), "next");
    });
  }

  test("refuses other hosts", async () => {
    const response = proxy(mcpPost("http://evil.example.com/api/mcp"));
    assert.equal(response.status, 403);
    assert.match(((await response.json()) as { error: string }).error, /INLINE_ALLOWED_HOSTS/);
  });

  test("INLINE_ALLOWED_HOSTS adds hosts", async () => {
    process.env.INLINE_ALLOWED_HOSTS = "inline.example.com, other.test";
    assert.equal(await status(proxy(mcpPost("http://inline.example.com/api/mcp"))), "next");
    assert.equal(proxy(mcpPost("http://third.test/api/mcp")).status, 403);
  });
});

describe("cross-site requests (CSRF)", () => {
  test("MCP clients send no Origin and are allowed", async () => {
    assert.equal(await status(proxy(mcpPost())), "next");
  });

  test("same-origin browser requests are allowed", async () => {
    assert.equal(await status(proxy(mcpPost(undefined, { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }))), "next");
  });

  test("a page on another site can't call tools", async () => {
    const response = proxy(mcpPost(undefined, { origin: "https://evil.example.com" }));
    assert.equal(response.status, 403);
  });

  test("a cross-site fetch without Origin is caught by Sec-Fetch-Site", async () => {
    assert.equal(proxy(mcpPost(undefined, { "sec-fetch-site": "cross-site" })).status, 403);
  });

  test("a malformed Origin is refused", async () => {
    assert.equal(proxy(mcpPost(undefined, { origin: "null" })).status, 403);
  });

  test("reads are not origin-checked", async () => {
    assert.equal(await status(proxy(request("http://localhost:3000/api/documents", { headers: { origin: "https://evil.example.com" } }))), "next");
  });
});

describe("access token", () => {
  test("without the token, the API answers 401", async () => {
    process.env.INLINE_ACCESS_TOKEN = "s3cret";
    const response = proxy(mcpPost());
    assert.equal(response.status, 401);
    assert.match(((await response.json()) as { error: string }).error, /access token/);
  });

  test("a Bearer token (how MCP clients authenticate) is accepted", async () => {
    process.env.INLINE_ACCESS_TOKEN = "s3cret";
    assert.equal(await status(proxy(mcpPost(undefined, { authorization: "Bearer s3cret" }))), "next");
    assert.equal(proxy(mcpPost(undefined, { authorization: "Bearer wrong" })).status, 401);
  });

  test("the cookie is accepted", async () => {
    process.env.INLINE_ACCESS_TOKEN = "s3cret";
    assert.equal(await status(proxy(mcpPost(undefined, { cookie: "inline_token=s3cret" }))), "next");
  });

  test("visiting a page with ?token= stores the cookie and strips the token from the URL", async () => {
    process.env.INLINE_ACCESS_TOKEN = "s3cret";
    const response = proxy(request("http://localhost:3000/d/abc?token=s3cret"));
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "http://localhost:3000/d/abc");
    const cookie = response.headers.get("set-cookie") ?? "";
    assert.match(cookie, /inline_token=s3cret/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=strict/i);
  });

  test("?token= is not accepted on the API itself", async () => {
    process.env.INLINE_ACCESS_TOKEN = "s3cret";
    assert.equal(proxy(mcpPost("http://localhost:3000/api/mcp?token=s3cret")).status, 401);
  });

  test("pages without the token explain how to open Inline", async () => {
    process.env.INLINE_ACCESS_TOKEN = "s3cret";
    const response = proxy(request("http://localhost:3000/"));
    assert.equal(response.status, 401);
    assert.match(await response.text(), /\?token=/);
  });
});

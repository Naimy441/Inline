import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../../proxy";

function request(url: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  const host = new URL(url).host;
  return new NextRequest(url, { method: init.method ?? "GET", headers: { host, ...init.headers } });
}

const passes = (response: Response) => response.headers.get("x-middleware-next") === "1";

afterEach(() => {
  delete process.env.INLINE_ALLOWED_HOSTS;
  delete process.env.INLINE_ACCESS_TOKEN;
});

describe("host allow-list", () => {
  it("answers local hosts", () => {
    for (const url of ["http://localhost:3000/", "http://127.0.0.1:3000/api/documents", "http://[::1]:3000/", "http://app.localhost/"]) {
      assert.ok(passes(proxy(request(url))), url);
    }
  });

  it("refuses other hosts unless they are listed", async () => {
    const response = proxy(request("http://evil.example/api/documents"));
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /INLINE_ALLOWED_HOSTS/);
    process.env.INLINE_ALLOWED_HOSTS = "docs.internal, other.host";
    assert.ok(passes(proxy(request("http://docs.internal:8080/"))));
    assert.equal(proxy(request("http://evil.example/")).status, 403);
  });
});

describe("cross-site writes", () => {
  it("allows same-origin writes and writes without an Origin (MCP clients)", () => {
    assert.ok(passes(proxy(request("http://localhost:3000/api/documents", { method: "POST", headers: { origin: "http://localhost:3000" } }))));
    assert.ok(passes(proxy(request("http://localhost:3000/api/mcp", { method: "POST" }))));
  });

  it("blocks writes from another origin", () => {
    assert.equal(proxy(request("http://localhost:3000/api/documents", { method: "POST", headers: { origin: "http://evil.example" } })).status, 403);
    assert.equal(proxy(request("http://localhost:3000/api/documents", { method: "DELETE", headers: { origin: "null" } })).status, 403);
    assert.equal(proxy(request("http://localhost:3000/api/documents", { method: "POST", headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  });

  it("lets reads through from anywhere on an allowed host", () => {
    assert.ok(passes(proxy(request("http://localhost:3000/api/documents", { headers: { origin: "http://evil.example" } }))));
  });
});

describe("access token", () => {
  it("requires the token on the API as a bearer or cookie", () => {
    process.env.INLINE_ACCESS_TOKEN = "s3cret";
    assert.equal(proxy(request("http://localhost:3000/api/documents")).status, 401);
    assert.ok(passes(proxy(request("http://localhost:3000/api/documents", { headers: { authorization: "Bearer s3cret" } }))));
    assert.ok(passes(proxy(request("http://localhost:3000/api/documents", { headers: { cookie: "inline_token=s3cret" } }))));
    assert.equal(proxy(request("http://localhost:3000/api/documents", { headers: { authorization: "Bearer wrong" } })).status, 401);
  });

  it("stores the cookie when a page is opened with ?token and drops it from the URL", () => {
    process.env.INLINE_ACCESS_TOKEN = "s3cret";
    const response = proxy(request("http://localhost:3000/d/abc?token=s3cret"));
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "http://localhost:3000/d/abc");
    assert.match(response.headers.get("set-cookie") ?? "", /inline_token=s3cret.*HttpOnly/i);
    assert.equal(proxy(request("http://localhost:3000/d/abc")).status, 401);
  });
});

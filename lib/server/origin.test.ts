import assert from "node:assert/strict";
import { after, test } from "node:test";

import { forgetServerOrigin, rememberServerOrigin, serverOrigin } from "@/lib/server/origin";

after(() => {
  forgetServerOrigin();
});

test("remembers a loopback origin and ignores a public host", () => {
  rememberServerOrigin(new Request("https://evil.example/api/documents"));
  rememberServerOrigin(new Request("http://localhost:3199/api/mcp"));
  assert.equal(serverOrigin(), "http://localhost:3199");
  rememberServerOrigin(new Request("https://docs.example/api/mcp"));
  assert.equal(serverOrigin(), "http://localhost:3199");
  rememberServerOrigin(new Request("http://127.0.0.1:4320/api/documents/abc"));
  assert.equal(serverOrigin(), "http://127.0.0.1:4320");
});

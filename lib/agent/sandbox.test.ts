import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runSandboxedJs } from "./sandbox";

describe("runSandboxedJs", () => {
  it("evaluates plain math", () => {
    const result = runSandboxedJs("return 2 + 40");
    assert.deepEqual(result, { result: "42" });
  });

  it("blocks eval and process", () => {
    assert.equal("error" in runSandboxedJs("return eval('1')"), true);
    assert.equal("error" in runSandboxedJs("return process.env"), true);
  });

  it("times out runaway loops", () => {
    const result = runSandboxedJs("while (true) {}");
    assert.equal("error" in result, true);
  });
});

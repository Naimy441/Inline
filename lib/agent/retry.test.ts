import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRateLimitText, isRetryableError, parseRetryAfterFromText, retryDelayMs } from "./retry";

describe("rate limit retry", () => {
  it("reads OpenAI try-again hints with a glued unit", () => {
    const ms = parseRetryAfterFromText(
      "Rate limit reached for gpt-5.4-nano on tokens per min (TPM). Please try again in 6.832s.",
    );
    assert.ok(ms && ms >= 6_000 && ms <= 8_000);
    assert.equal(isRateLimitText("The model hit a rate limit (tokens per minute). Wait a moment and try again."), true);
    assert.equal(
      isRetryableError(new Error("Rate limit reached for gpt-5.4-nano on tokens per min (TPM). Please try again in 6.832s.")),
      true,
    );
  });

  it("waits at least a few seconds for TPM errors even without a hint", () => {
    const delay = retryDelayMs(1, undefined, true);
    assert.ok(delay >= 4_000);
  });
});

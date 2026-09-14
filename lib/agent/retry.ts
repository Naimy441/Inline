export const MAX_BACKOFF_ATTEMPTS = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 45_000;

export type BackoffEvent = {
  type: "retry";
  attempt: number;
  delayMs: number;
  message: string;
};

export class HttpError extends Error {
  status: number;
  body: string;
  retryAfterMs?: number;

  constructor(status: number, message: string, body = "", retryAfterMs?: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isAbortError(error: unknown) {
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  return error instanceof Error && error.name === "AbortError";
}

export function isRateLimitText(text: string) {
  return /rate limit|tokens per min|tpm|too many requests|rate_limit/i.test(text);
}

export function isRetryableStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function isRateLimitError(error: unknown) {
  if (error instanceof HttpError && (error.status === 429 || isRateLimitText(error.message))) return true;
  return error instanceof Error && isRateLimitText(error.message);
}

export function isAuthError(error: unknown) {
  return error instanceof HttpError && (error.status === 401 || error.status === 403);
}

export function parseRetryAfterFromText(text: string): number | undefined {
  const match = text.match(/try again in\s+([\d.]+)\s*(ms|milliseconds|s|sec|secs|seconds)?/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  const unit = (match[2] || "s").toLowerCase();
  const ms = unit.startsWith("ms") || unit.startsWith("millisecond") ? value : value * 1000;
  return Math.min(MAX_DELAY_MS, Math.max(250, ms));
}

export function parseRetryAfterMs(res: Response, body: string): number | undefined {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_DELAY_MS, Math.max(250, seconds * 1000));
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(MAX_DELAY_MS, Math.max(250, date - Date.now()));
  }
  const resetTokens = res.headers.get("x-ratelimit-reset-tokens") || res.headers.get("x-ratelimit-reset-requests");
  if (resetTokens) {
    if (/^\d+(\.\d+)?s$/i.test(resetTokens)) {
      return Math.min(MAX_DELAY_MS, Math.max(250, Number.parseFloat(resetTokens) * 1000));
    }
    const seconds = Number(resetTokens);
    if (Number.isFinite(seconds) && seconds >= 0 && seconds < 3600) {
      return Math.min(MAX_DELAY_MS, Math.max(250, seconds * 1000));
    }
  }
  return parseRetryAfterFromText(body);
}

export function retryAfterMsFromError(error: unknown): number | undefined {
  if (error instanceof HttpError && error.retryAfterMs) return error.retryAfterMs;
  if (error instanceof Error) return parseRetryAfterFromText(error.message);
  return undefined;
}

export function messageFromBody(body: string, status: number) {
  try {
    const json = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof json.error === "string" && json.error.trim()) return json.error.trim();
    if (json.error && typeof json.error === "object" && typeof json.error.message === "string") {
      return json.error.message.trim();
    }
    if (typeof json.message === "string" && json.message.trim()) return json.message.trim();
  } catch {
    /* not JSON */
  }
  const trimmed = body.replace(/\s+/g, " ").trim();
  if (trimmed) return trimmed.slice(0, 500);
  return `Request failed (${status}).`;
}

export function publicModelError(raw: string) {
  if (isRateLimitText(raw)) {
    const wait = parseRetryAfterFromText(raw);
    const waitLabel = wait ? ` Wait about ${Math.max(1, Math.ceil(wait / 1000))}s` : " Wait a moment";
    return `The model hit a rate limit (tokens per minute).${waitLabel} and try again, or switch models.`;
  }
  return raw.replace(/organization org-[A-Za-z0-9]+/gi, "your organization").replace(/\s+/g, " ").trim();
}

export function retryDelayMs(attempt: number, hintedMs?: number) {
  const expo = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 300);
  return Math.min(MAX_DELAY_MS, Math.max(hintedMs ?? 0, expo) + jitter);
}

export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError() {
  return typeof DOMException !== "undefined"
    ? new DOMException("Aborted", "AbortError")
    : Object.assign(new Error("Aborted"), { name: "AbortError" });
}

export async function* backoffFetch(
  url: string,
  init: RequestInit,
  options?: { signal?: AbortSignal; maxAttempts?: number },
): AsyncGenerator<BackoffEvent, Response> {
  const signal = options?.signal ?? init.signal ?? undefined;
  const maxAttempts = options?.maxAttempts ?? MAX_BACKOFF_ATTEMPTS;
  let lastError: Error = new Error("Request failed.");

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw abortError();
    try {
      const res = await fetch(url, { ...init, signal });
      if (res.ok) return res;
      const body = await res.text().catch(() => "");
      const message = messageFromBody(body, res.status);
      const retryAfterMs = parseRetryAfterMs(res, `${message}\n${body}`);
      lastError = new HttpError(res.status, message, body, retryAfterMs);
      if (!isRetryableStatus(res.status) && !isRateLimitText(message)) throw lastError;
      if (attempt >= maxAttempts) throw lastError;
      const delayMs = retryDelayMs(attempt, retryAfterMs);
      yield {
        type: "retry",
        attempt,
        delayMs,
        message: retryStepTitle(message, delayMs, attempt, maxAttempts),
      };
      await sleep(delayMs, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof HttpError) {
        lastError = error;
        if (attempt >= maxAttempts || (!isRetryableStatus(error.status) && !isRateLimitText(error.message))) {
          throw error;
        }
        const delayMs = retryDelayMs(attempt, error.retryAfterMs);
        yield {
          type: "retry",
          attempt,
          delayMs,
          message: retryStepTitle(error.message, delayMs, attempt, maxAttempts),
        };
        await sleep(delayMs, signal);
        continue;
      }
      lastError = error instanceof Error ? error : new Error("Network request failed.");
      if (attempt >= maxAttempts || !isTransientNetwork(lastError)) throw lastError;
      const delayMs = retryDelayMs(attempt);
      yield {
        type: "retry",
        attempt,
        delayMs,
        message: retryStepTitle(lastError.message, delayMs, attempt, maxAttempts),
      };
      await sleep(delayMs, signal);
    }
  }

  throw lastError;
}

export async function fetchWithBackoff(
  url: string,
  init: RequestInit,
  options?: { signal?: AbortSignal; maxAttempts?: number },
): Promise<Response> {
  const gen = backoffFetch(url, init, options);
  let step = await gen.next();
  while (!step.done) step = await gen.next();
  return step.value;
}

function retryStepTitle(raw: string, delayMs: number, attempt: number, maxAttempts: number) {
  const seconds = Math.max(1, Math.ceil(delayMs / 1000));
  if (isRateLimitText(raw)) {
    return `Rate limited — waiting ${seconds}s (try ${attempt + 1}/${maxAttempts})`;
  }
  return `Retrying in ${seconds}s (try ${attempt + 1}/${maxAttempts})`;
}

function isTransientNetwork(error: Error) {
  return /network|fetch failed|failed to fetch|socket|econnreset|etimedout|eai_again/i.test(error.message);
}

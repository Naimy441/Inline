"use client";

/** Typed fetch helpers for Inline's API. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const response = await fetch(path, {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...rest.headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: "no-store",
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }
  if (!response.ok) throw new ApiError(response.status, String(body.error ?? `Request failed (${response.status}).`), body);
  return body as T;
}

export const post = <T>(path: string, json?: unknown) => api<T>(path, { method: "POST", json: json ?? {} });
export const patch = <T>(path: string, json: unknown) => api<T>(path, { method: "PATCH", json });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });

export async function uploadFile(file: File) {
  const form = new FormData();
  form.append("file", file);
  return api<{ id: string; url: string; name: string; mime: string; size: number; kind: "image" | "text" | "pdf" }>("/api/uploads", {
    method: "POST",
    body: form,
  });
}

/** A tiny observable store usable with React's useSyncExternalStore. */
export class Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get = () => this.value;
  set(next: T | ((value: T) => T)) {
    this.value = typeof next === "function" ? (next as (value: T) => T)(this.value) : next;
    for (const listener of this.listeners) listener();
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

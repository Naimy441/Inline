"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { PlanUsage } from "@/lib/agent/types";
import { api, Store } from "@/lib/client/api";

type State = { usage: PlanUsage | null; loading: boolean; fetchedAt: number };

const store = new Store<State>({ usage: null, loading: false, fetchedAt: 0 });
let inflight: Promise<void> | null = null;

/** Fetch the account's plan usage; skipped when it was fetched in the last `maxAgeMs`. */
export function refreshPlanUsage(maxAgeMs = 30_000) {
  if (inflight) return inflight;
  if (Date.now() - store.get().fetchedAt < maxAgeMs) return Promise.resolve();
  store.set((state) => ({ ...state, loading: true }));
  inflight = api<{ usage: PlanUsage | null }>(`/api/agent/usage${maxAgeMs === 0 ? "?refresh=1" : ""}`)
    .then((result) => store.set({ usage: result.usage, loading: false, fetchedAt: Date.now() }))
    .catch(() => store.set((state) => ({ ...state, loading: false, fetchedAt: Date.now() })))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Plan usage, refreshed when Claude finishes a reply and every few minutes while shown. */
export function usePlanUsage(running: boolean) {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  useEffect(() => {
    // Inline refreshes its own copy as a reply ends; fetch it a moment later.
    const settle = running ? null : setTimeout(() => void refreshPlanUsage(5_000), 1500);
    const timer = setInterval(() => void refreshPlanUsage(), 3 * 60_000);
    return () => {
      if (settle) clearTimeout(settle);
      clearInterval(timer);
    };
  }, [running]);
  return state;
}

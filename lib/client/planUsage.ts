"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { AgentProvider } from "@/lib/agent/providers";
import type { PlanUsage } from "@/lib/agent/types";
import { api, Store } from "@/lib/client/api";

type State = { usage: PlanUsage | null; loading: boolean; fetchedAt: number };

const stores = { claude: new Store<State>({ usage: null, loading: false, fetchedAt: 0 }), codex: new Store<State>({ usage: null, loading: false, fetchedAt: 0 }) };
const pending: Record<AgentProvider, Promise<void> | null> = { claude: null, codex: null };

/** Fetch the account's plan usage; skipped when it was fetched in the last `maxAgeMs`. */
export function refreshPlanUsage(maxAgeMs = 30_000, provider: AgentProvider = "claude") {
  const store = stores[provider];
  const inflight = pending[provider];
  if (inflight) return inflight;
  if (Date.now() - store.get().fetchedAt < maxAgeMs) return Promise.resolve();
  store.set((state) => ({ ...state, loading: true }));
  pending[provider] = api<{ usage: PlanUsage | null }>(`/api/agent/usage?provider=${provider}${maxAgeMs === 0 ? "&refresh=1" : ""}`)
    .then((result) => store.set({ usage: result.usage, loading: false, fetchedAt: Date.now() }))
    .catch(() => store.set((state) => ({ ...state, loading: false, fetchedAt: Date.now() })))
    .finally(() => {
      pending[provider] = null;
    });
  return pending[provider];
}

/** Plan usage, loaded while Claude is working and again when a reply ends. */
export function usePlanUsage(running: boolean, provider: AgentProvider = "claude") {
  const store = stores[provider];
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  useEffect(() => {
    // The ring stays on screen during a reply, so usage has to load then too,
    // not only once Claude is idle.
    void refreshPlanUsage(running ? 5_000 : 15_000, provider);
    // Inline refreshes its own copy as a reply ends; fetch it a moment later.
    const settle = running ? null : setTimeout(() => void refreshPlanUsage(5_000, provider), 1500);
    const timer = setInterval(() => void refreshPlanUsage(30_000, provider), 3 * 60_000);
    return () => {
      if (settle) clearTimeout(settle);
      clearInterval(timer);
    };
  }, [running, provider]);
  return state;
}

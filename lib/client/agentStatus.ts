"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { AgentProvider } from "@/lib/agent/providers";
import type { AgentStatus, ChatSettings } from "@/lib/agent/types";
import { api, Store } from "@/lib/client/api";

type State = { status: AgentStatus | null; defaults: ChatSettings | null; loading: boolean };

const stores = { claude: new Store<State>({ status: null, defaults: null, loading: false }), codex: new Store<State>({ status: null, defaults: null, loading: false }) };
const pending: Record<AgentProvider, Promise<void> | null> = { claude: null, codex: null };

export function refreshAgentStatus(force = false, provider: AgentProvider = "claude") {
  const store = stores[provider];
  const inflight = pending[provider];
  if (inflight && !force) return inflight;
  store.set((state) => ({ ...state, loading: true }));
  pending[provider] = api<{ status: AgentStatus; defaults: ChatSettings }>(`/api/agent/status?provider=${provider}${force ? "&refresh=1" : ""}`)
    .then((result) => store.set({ status: result.status, defaults: result.defaults, loading: false }))
    .catch((error: unknown) =>
      store.set({
        status: { state: "unavailable", message: error instanceof Error ? error.message : "Couldn't reach the Inline server.", checkedAt: Date.now() },
        defaults: null,
        loading: false,
      }),
    )
    .finally(() => {
      pending[provider] = null;
    });
  return pending[provider];
}

export function useAgentStatus(provider: AgentProvider = "claude") {
  const store = stores[provider];
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  useEffect(() => {
    if (!state.status && !state.loading) void refreshAgentStatus(false, provider);
  }, [state.status, state.loading, provider]);
  return state;
}

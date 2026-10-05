"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { AgentStatus, ChatSettings } from "@/lib/agent/types";
import { api, Store } from "@/lib/client/api";

type State = { status: AgentStatus | null; defaults: ChatSettings | null; loading: boolean };

const store = new Store<State>({ status: null, defaults: null, loading: false });
let inflight: Promise<void> | null = null;

export function refreshAgentStatus(force = false) {
  if (inflight && !force) return inflight;
  store.set((state) => ({ ...state, loading: true }));
  inflight = api<{ status: AgentStatus; defaults: ChatSettings }>(`/api/agent/status${force ? "?refresh=1" : ""}`)
    .then((result) => store.set({ status: result.status, defaults: result.defaults, loading: false }))
    .catch((error: unknown) =>
      store.set({
        status: { state: "unavailable", message: error instanceof Error ? error.message : "Couldn't reach the Inline server.", checkedAt: Date.now() },
        defaults: null,
        loading: false,
      }),
    )
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useAgentStatus() {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  useEffect(() => {
    if (!state.status && !state.loading) void refreshAgentStatus();
  }, [state.status, state.loading]);
  return state;
}

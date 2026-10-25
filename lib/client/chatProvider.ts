"use client";

import { useSyncExternalStore } from "react";
import type { AgentProvider } from "@/lib/agent/providers";
import { Store } from "@/lib/client/api";

/**
 * The provider of the AI chat on screen, so the toolbar can show its mark.
 * The chat panel sets it; until a chat has opened, the toolbar shows Claude.
 */
const store = new Store<AgentProvider>("claude");

export function setChatProvider(provider: AgentProvider) {
  if (store.get() !== provider) store.set(provider);
}

export function useChatProvider() {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

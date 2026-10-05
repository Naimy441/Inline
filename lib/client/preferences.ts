"use client";

import { Store } from "@/lib/client/api";

/** Per-browser editor preferences, remembered in localStorage. */
export type Preferences = {
  substitutions: boolean;
  showInvisibles: boolean;
};

const KEY = "inline-preferences";
const DEFAULTS: Preferences = { substitutions: true, showInvisibles: false };

function load(): Preferences {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Partial<Preferences>;
    return {
      substitutions: typeof raw.substitutions === "boolean" ? raw.substitutions : DEFAULTS.substitutions,
      showInvisibles: typeof raw.showInvisibles === "boolean" ? raw.showInvisibles : DEFAULTS.showInvisibles,
    };
  } catch {
    return DEFAULTS;
  }
}

export const preferences = new Store<Preferences>(DEFAULTS);
let loaded = false;

/** Read stored preferences once, on the client (not during server rendering). */
export function loadPreferences() {
  if (!loaded && typeof window !== "undefined") {
    loaded = true;
    preferences.set(load());
  }
  return preferences.get();
}

export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]) {
  preferences.set((current) => ({ ...current, [key]: value }));
  try {
    window.localStorage.setItem(KEY, JSON.stringify(preferences.get()));
  } catch {
    // Private browsing: the preference lasts for this tab.
  }
}

export const DEFAULT_PREFERENCES = DEFAULTS;

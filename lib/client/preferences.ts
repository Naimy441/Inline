"use client";

import { Store } from "@/lib/client/api";

/** Per-browser editor preferences, remembered in localStorage. */
export type Preferences = {
  substitutions: boolean;
  showInvisibles: boolean;
  /** Red spelling underlines in the document. */
  spellcheck: boolean;
  /** Words never underlined as misspelled (normalized: lower case). */
  dictionary: string[];
  /** Help → Developer options: copy prompts, thoughts, tool calls and replies. */
  devOptions: boolean;
};

const KEY = "inline-preferences";
const DEFAULTS: Preferences = { substitutions: true, showInvisibles: false, spellcheck: true, dictionary: [], devOptions: false };

function load(): Preferences {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Partial<Preferences> & { showRuler?: unknown };
    const next: Preferences = {
      substitutions: typeof raw.substitutions === "boolean" ? raw.substitutions : DEFAULTS.substitutions,
      showInvisibles: typeof raw.showInvisibles === "boolean" ? raw.showInvisibles : DEFAULTS.showInvisibles,
      spellcheck: typeof raw.spellcheck === "boolean" ? raw.spellcheck : DEFAULTS.spellcheck,
      dictionary: Array.isArray(raw.dictionary) ? raw.dictionary.filter((word): word is string => typeof word === "string").slice(0, 5000) : DEFAULTS.dictionary,
      devOptions: raw.devOptions === true,
    };
    // Drop the removed ruler toggle so an old stored choice cannot come back.
    if ("showRuler" in raw) {
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Private browsing: the leftover choice is ignored.
      }
    }
    return next;
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

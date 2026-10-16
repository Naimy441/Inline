import { pageAppearance, type PageAppearance } from "@/lib/pdf/screenAppearance";
import { readSettingsFile } from "@/lib/server/store";

export type { PageAppearance };

/** Unit tests pin the saved appearance. Pass null to read it from the store again. */
let forced: PageAppearance | null = null;

export function setSavedAppearance(next: PageAppearance | null) {
  forced = next;
}

/**
 * The light or dark appearance saved from the user's browser.
 * A closed document has no editor to ask, so a screenshot uses this.
 * Light until the app has reported one.
 */
export async function savedAppearance(): Promise<PageAppearance> {
  if (forced) return forced;
  const stored = await readSettingsFile<{ appearance?: unknown }>("preferences");
  return pageAppearance(stored?.appearance) ?? "light";
}

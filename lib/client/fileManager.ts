"use client";

import { api, ApiError, patch, post } from "@/lib/client/api";
import { toast } from "@/components/ui/Toast";

/**
 * "Show in Finder" for documents and folders: opens their Word copies (see
 * lib/server/mirror.ts) in the file manager of the computer Inline runs on.
 * The label follows that computer's system, which the server reports.
 */

let platform: Promise<string | null> | null = null;
let known: string | null = null;

/**
 * Ask the server once which system it runs on. Nothing re-renders when the
 * answer comes: menus read it when they open (re-rendering the editor while
 * someone selects text would close the selection bubble).
 */
export function loadServerPlatform() {
  platform ??= api<{ mirror: { platform?: string } }>("/api/mirror")
    .then(({ mirror }) => (known = mirror.platform ?? null))
    .catch(() => null);
  return platform;
}

export function revealLabel(os: string | null) {
  return os === "darwin" ? "Show in Finder" : os === "win32" ? "Show in File Explorer" : "Show in folder";
}

/** The menu label for the server's system ("Show in Finder" on a Mac), as far as it's known yet. */
export function currentRevealLabel() {
  void loadServerPlatform();
  return revealLabel(known);
}

type Target = { documentId?: string; folderId?: string | null };

/** Open a document's file, a folder, or (no target) the whole folder on disk; offers to turn copies on if they're off. */
export async function revealOnDisk(target: Target = {}): Promise<void> {
  try {
    await post("/api/mirror/reveal", target);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      toast("Copies on this computer are off, so there's no file to show.", {
        tone: "error",
        duration: 8000,
        action: {
          label: "Turn on",
          run: () =>
            void patch("/api/mirror", { enabled: true })
              .then(() => post("/api/mirror/reveal", target))
              .catch((retry: unknown) => toast(retry instanceof Error ? retry.message : "Couldn't show it.", { tone: "error" })),
        },
      });
      return;
    }
    toast(error instanceof Error ? error.message : "Couldn't show it in the file manager.", { tone: "error" });
  }
}

/**
 * "Something about the documents changed": saved, created, deleted, or the
 * folders changed. The disk copy (lib/server/mirror.ts) listens, loaded on
 * first use so the hub and the folder store don't import it.
 */
export function libraryChanged() {
  void import("@/lib/server/mirror")
    .then(({ mirror }) => mirror().poke())
    .catch(() => undefined);
}

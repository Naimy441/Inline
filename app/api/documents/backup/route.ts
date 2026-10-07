import { createZip } from "@/lib/doc/zip";
import { route } from "@/lib/server/http";
import { documentHub } from "@/lib/server/hub";
import { mirror } from "@/lib/server/mirror";

/**
 * Download all: every document as a Word file, in the same folders and with
 * the same names as the copies on this computer (lib/server/mirror.ts), so
 * the ZIP is that folder. Trashed documents are in "Inline Trash".
 */
export const GET = route(async () => {
  await documentHub().flushAll();
  const entries = await mirror().tree();
  const date = new Date().toISOString().slice(0, 10);
  return new Response(new Uint8Array(createZip(entries)), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="Inline documents ${date}.zip"`,
      "Cache-Control": "no-store",
    },
  });
});

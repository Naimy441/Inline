import { z } from "zod";
import { HttpError, json, readJson, route } from "@/lib/server/http";
import { mirror, mirrorConfig, revealInFileManager } from "@/lib/server/mirror";

const Body = z.object({
  documentId: z.string().max(80).optional(),
  folderId: z.string().max(80).nullable().optional(),
});

/**
 * Show a document's Word copy, or a folder, in the file manager of the
 * computer Inline runs on. Paths come from the mirror, never from the request.
 */
export const POST = route(async (request) => {
  const body = await readJson(request, Body);
  if (!(await mirrorConfig()).enabled) throw new HttpError(409, "Copies on this computer are off. Turn them on to see your documents in a folder.");
  const found = await mirror().locate(body);
  if (!found) throw new HttpError(404, "That isn't in the folder yet.");
  try {
    await revealInFileManager(found.path, found.isFile);
  } catch (error) {
    throw new HttpError(501, error instanceof Error ? error.message : "Couldn't open the file manager.");
  }
  return json({ path: found.path });
});

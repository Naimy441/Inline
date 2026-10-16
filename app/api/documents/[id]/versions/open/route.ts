import { z } from "zod";
import { HttpError, json, readJson, route, routeDocument } from "@/lib/server/http";
import { VersionFilesError } from "@/lib/server/repo";
import { openVersionOnDisk } from "@/lib/server/versionOpen";

type Context = { params: Promise<{ id: string }> };

const Body = z.object({
  versionId: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  file: z.string().min(1).max(1024).optional(),
});

/**
 * From version history: open one file with the system's open-with chooser,
 * or open the folder that holds that version's files. The file, when given,
 * is the only thing handed to the chosen app.
 */
export const POST = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const body = await readJson(request, Body);
  try {
    const opened = await openVersionOnDisk(doc.id, body.versionId ?? null, body.file);
    return json(body.file ? { file: opened.file } : { folder: opened.folder });
  } catch (error) {
    if (error instanceof VersionFilesError) throw new HttpError(400, error.message);
    throw error;
  }
});

import { z } from "zod";
import { HttpError, json, readJson, route } from "@/lib/server/http";
import { folderExists } from "@/lib/server/folders";
import { documentHub } from "@/lib/server/hub";

export const GET = route(async (request) => {
  const trashed = new URL(request.url).searchParams.get("trashed") === "1";
  return json({ documents: await documentHub().list({ trashed }) });
});

const CreateBody = z.object({
  title: z.string().max(300).optional(),
  markdown: z.string().max(5_000_000).optional(),
  doc: z.unknown().optional(),
  settings: z.unknown().optional(),
  folderId: z.string().max(80).nullable().optional(),
});

/** DELETE ?trashed=1 empties the trash: every trashed document is deleted forever. */
export const DELETE = route(async (request) => {
  if (new URL(request.url).searchParams.get("trashed") !== "1") throw new HttpError(400, "Only the trash can be emptied (?trashed=1).");
  const deleted = await documentHub().emptyTrash();
  return json({ deleted });
});

export const POST = route(async (request) => {
  const body = await readJson(request, CreateBody);
  if (body.folderId && !(await folderExists(body.folderId))) throw new HttpError(404, "That folder was not found.");
  const doc = await documentHub().create(body);
  return json({ document: doc.snapshot() }, { status: 201 });
});

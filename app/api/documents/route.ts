import { compileCanvas } from "@/lib/canvas/compiler";
import { CANVAS_EXAMPLES } from "@/lib/canvas/examples";
import { UNRESTRICTED_STARTER, unrestrictedCanvasDoc } from "@/lib/canvas/unrestricted";
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
  canvas: z.enum(["blank", "editorial", "research", "guide", "unrestricted"]).optional(),
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
  const example = body.canvas && body.canvas !== "blank" && body.canvas !== "unrestricted" ? CANVAS_EXAMPLES[body.canvas] : null;
  const canvas = body.canvas === "blank" ? compileCanvas("<Canvas></Canvas>") : example ? compileCanvas(example.html, example.css) : null;
  if (body.canvas === "unrestricted") {
    const doc = await documentHub().create({ ...body, title: body.title || "Untitled canvas", doc: unrestrictedCanvasDoc(UNRESTRICTED_STARTER).toJSON() });
    return json({ document: doc.snapshot() }, { status: 201 });
  }
  const doc = await documentHub().create(canvas ? { ...body, title: body.title || example?.title || "Untitled canvas", doc: canvas.toJSON() } : body);
  return json({ document: doc.snapshot() }, { status: 201 });
});

import { z } from "zod";
import { FOLDER_COLORS } from "@/lib/doc/folders";
import { HttpError, json, readJson, route } from "@/lib/server/http";
import { deleteFolder, FolderError, updateFolder } from "@/lib/server/folders";

type Context = { params: Promise<{ id: string }> };

const PatchBody = z.object({
  name: z.string().max(300).optional(),
  parentId: z.string().max(80).nullable().optional(),
  color: z.enum(FOLDER_COLORS).optional(),
});

function folderErrors<T>(run: () => Promise<T>) {
  return run().catch((error: unknown) => {
    if (error instanceof FolderError) throw new HttpError(/not found/.test(error.message) ? 404 : 422, error.message);
    throw error;
  });
}

export const PATCH = route(async (request, context: Context) => {
  const { id } = await context.params;
  const body = await readJson(request, PatchBody);
  return json({ folder: await folderErrors(() => updateFolder(id, body)) });
});

/** Deletes the folder and the folders inside; their documents move to the trash. */
export const DELETE = route(async (_request, context: Context) => {
  const { id } = await context.params;
  return json(await folderErrors(() => deleteFolder(id)));
});

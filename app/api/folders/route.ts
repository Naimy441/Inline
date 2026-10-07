import { z } from "zod";
import { FOLDER_COLORS } from "@/lib/doc/folders";
import { HttpError, json, readJson, route } from "@/lib/server/http";
import { createFolder, FolderError, listFolders } from "@/lib/server/folders";

export const GET = route(async () => json({ folders: await listFolders() }));

const CreateBody = z.object({
  name: z.string().max(300).optional(),
  parentId: z.string().max(80).nullable().optional(),
  color: z.enum(FOLDER_COLORS).optional(),
});

export const POST = route(async (request) => {
  const body = await readJson(request, CreateBody);
  try {
    return json({ folder: await createFolder(body) }, { status: 201 });
  } catch (error) {
    if (error instanceof FolderError) throw new HttpError(422, error.message);
    throw error;
  }
});

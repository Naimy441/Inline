import { z } from "zod";
import { FOLDER_COLORS } from "@/lib/doc/folders";
import { json, readJson, route } from "@/lib/server/http";
import { restoreFolders } from "@/lib/server/folders";

const Body = z.object({
  folders: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
        name: z.string().max(300),
        parentId: z.string().max(80).nullable(),
        color: z.enum(FOLDER_COLORS),
        createdAt: z.number(),
        updatedAt: z.number(),
      }),
    )
    .max(2000),
});

/** Put back folders a delete removed (its Undo). Their documents name them still, so restoring those from the trash refiles them. */
export const POST = route(async (request) => {
  const body = await readJson(request, Body);
  return json({ folders: await restoreFolders(body.folders) });
});

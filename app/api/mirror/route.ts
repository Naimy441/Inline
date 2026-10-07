import path from "node:path";
import { z } from "zod";
import { HttpError, json, readJson, route } from "@/lib/server/http";
import { mirror, mirrorConfig, setMirrorSettings } from "@/lib/server/mirror";

/** The Word copies of every document kept in a folder on disk: where they go, and how the copying is going. */
export const GET = route(async () => json({ mirror: await mirror().getStatus() }));

const PatchBody = z.object({
  enabled: z.boolean().optional(),
  /** An absolute path, or one starting with ~ for the home folder. */
  dir: z.string().max(1000).optional(),
});

export const PATCH = route(async (request) => {
  const body = await readJson(request, PatchBody);
  if ((await mirrorConfig()).source === "env") throw new HttpError(409, "The folder is set by INLINE_MIRROR_DIR on the server, so it can't be changed here.");
  const dir = body.dir?.trim();
  if (dir !== undefined && dir && !path.isAbsolute(dir) && dir !== "~" && !dir.startsWith("~/")) throw new HttpError(400, "Give the folder's full path, like ~/Documents/Inline or /Users/you/Documents/Inline.");
  return json({ mirror: await setMirrorSettings({ enabled: body.enabled, dir }) });
});

/** Copy everything now, rather than waiting for the next change. */
export const POST = route(async () => {
  await mirror().sync();
  return json({ mirror: await mirror().getStatus() });
});

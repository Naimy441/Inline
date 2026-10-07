import { z } from "zod";
import { json, readJson, route } from "@/lib/server/http";
import { readSettingsFile, writeSettingsFile } from "@/lib/server/store";

/** App-wide choices kept with the data rather than in one browser, such as which home page tips were dismissed. */

const Preferences = z
  .object({
    /** The "bring your Google Docs" tip on the home page. */
    googleImportDismissed: z.boolean().optional(),
  })
  .strict();

type Stored = z.infer<typeof Preferences>;

let writes: Promise<unknown> = Promise.resolve();

async function read(): Promise<Stored> {
  const parsed = Preferences.safeParse((await readSettingsFile<unknown>("preferences")) ?? {});
  return parsed.success ? parsed.data : {};
}

export const GET = route(async () => json({ preferences: await read() }));

export const PATCH = route(async (request) => {
  const patch = await readJson(request, Preferences);
  const run = writes.catch(() => undefined).then(async () => {
    const next = { ...(await read()), ...patch };
    await writeSettingsFile("preferences", next);
    return next;
  });
  writes = run.catch(() => undefined);
  return json({ preferences: await run });
});

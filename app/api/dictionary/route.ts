import { z } from "zod";
import { json, readJson, route } from "@/lib/server/http";
import { readDictionary, updateDictionary } from "@/lib/server/store";
import { normalizeWord } from "@/lib/doc/words";

/** The user's spelling dictionary: words that aren't underlined as misspelled. */
export const GET = route(async () => json({ words: await readDictionary() }));

const Body = z.object({ add: z.array(z.string().max(100)).max(5000).optional(), remove: z.array(z.string().max(100)).max(5000).optional() });

export const POST = route(async (request) => {
  const body = await readJson(request, Body);
  const clean = (words: string[] | undefined) => (words ?? []).map(normalizeWord).filter(Boolean);
  return json({ words: await updateDictionary(clean(body.add), clean(body.remove)) });
});

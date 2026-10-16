import { lookupWord } from "@/lib/dictionary/lookup";
import { HttpError, json, route } from "@/lib/server/http";

/** Definitions and synonyms for a word the user right-clicked. */
export const GET = route(async (request) => {
  const word = new URL(request.url).searchParams.get("word")?.trim() ?? "";
  if (!word) throw new HttpError(400, "Give a word to look up.");
  try {
    const entry = await lookupWord(word);
    return json(entry ? { found: true as const, ...entry } : { found: false as const });
  } catch {
    throw new HttpError(502, "The dictionary couldn't be reached.");
  }
});

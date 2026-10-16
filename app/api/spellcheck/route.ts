import { z } from "zod";
import { json, readJson, route } from "@/lib/server/http";
import { speller } from "@/lib/server/spellcheck";

const Body = z.object({ words: z.array(z.string().max(100)).max(2000) });

/**
 * Raw Hunspell verdicts for the editor's live underlines.
 * Possessives and the user's dictionary are applied in the editor; this list
 * is only "does the English dictionary contain this exact string".
 */
export const POST = route(async (request) => {
  const { words } = await readJson(request, Body);
  const check = await speller();
  const seen = new Set<string>();
  const incorrect: string[] = [];
  for (const word of words) {
    if (!word || seen.has(word)) continue;
    seen.add(word);
    if (!check.correct(word)) incorrect.push(word);
  }
  return json({ incorrect });
});

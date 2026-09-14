import { GRAMMAR_MODEL, GRAMMAR_MODEL_FALLBACKS } from "@/lib/agent/models";
import { fetchWithBackoff, publicModelError } from "@/lib/agent/retry";
import type { AgentEditDraft } from "@/lib/agent/types";

const SYSTEM = [
  "You correct grammar and spelling only.",
  "Do not change tone, voice, dialect, formality, or wording except to fix an actual error.",
  "Do not add ideas, sentences, or optional words. Do not remove ideas, sentences, or paragraph breaks.",
  "Do not rephrase, tighten, expand, or polish the writing.",
  "Keep line breaks exactly as given. Only fix spaces that are themselves errors.",
  'Return ONLY JSON: {"edits":[{"find":"exact original substring","replace":"corrected substring"}]}',
  "Each find must be copied exactly from the input, including spaces and newlines.",
  "Use the smallest find/replace that fixes each error.",
  'If the text is already correct, return {"edits":[]}.',
].join(" ");

export type GrammarFixResult = {
  edits: Array<Pick<AgentEditDraft, "find" | "replace">>;
  model: string;
  mock: boolean;
};

export async function fixGrammarText(text: string, signal?: AbortSignal): Promise<GrammarFixResult> {
  const source = text.replace(/\u00a0/g, " ");
  if (!source.trim()) return { edits: [], model: GRAMMAR_MODEL, mock: false };

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return { edits: localGrammarEdits(source), model: "local", mock: true };
  }

  let lastError = "";
  for (const model of [GRAMMAR_MODEL, ...GRAMMAR_MODEL_FALLBACKS]) {
    const result = await requestGrammarEdits(apiKey, model, source, signal);
    if (result.ok) {
      return { edits: sanitizeEdits(source, result.edits), model, mock: false };
    }
    lastError = result.error;
  }
  throw new Error(lastError || "Grammar model failed.");
}

async function requestGrammarEdits(
  apiKey: string,
  model: string,
  source: string,
  signal?: AbortSignal,
): Promise<{ ok: true; edits: unknown } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetchWithBackoff(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 2048,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: source },
          ],
        }),
      },
      { signal, maxAttempts: 4 },
    );
  } catch (error) {
    return {
      ok: false,
      error: publicModelError(error instanceof Error ? error.message : `Grammar model ${model} failed.`),
    };
  }
  const payload = (await res.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  const parsed = parseEditsJson(payload.choices?.[0]?.message?.content ?? "");
  if (!parsed) return { ok: false, error: "Empty grammar response." };
  return { ok: true, edits: parsed };
}

function parseEditsJson(raw: string) {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!text) return null;
  try {
    const json = JSON.parse(text) as { edits?: unknown };
    return json.edits ?? [];
  } catch {
    return null;
  }
}

function sanitizeEdits(source: string, raw: unknown): Array<{ find: string; replace: string }> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const edits: Array<{ find: string; replace: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as { find?: unknown; replace?: unknown };
    if (typeof row.find !== "string" || typeof row.replace !== "string") continue;
    const find = row.find.replace(/\u00a0/g, " ");
    const replace = row.replace.replace(/\u00a0/g, " ");
    if (!find || !replace || find === replace || !source.includes(find)) continue;
    if ((find.match(/\n/g) || []).length !== (replace.match(/\n/g) || []).length) continue;
    const slack = Math.max(8, Math.floor(find.length * 0.15));
    if (Math.abs(replace.length - find.length) > slack) continue;
    const key = `${find}\0${replace}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edits.push({ find, replace });
  }
  return edits;
}

function localGrammarEdits(source: string): Array<{ find: string; replace: string }> {
  const next = source
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/[^\S\n]+,/g, ",")
    .replace(/[^\S\n]+\./g, ".")
    .replace(/(^|[^\w])i(?=[^\w]|$)/g, "$1I");
  return next === source ? [] : [{ find: source, replace: next }];
}

import { AGENT_MODELS, DEFAULT_MODEL, THINKING_LEVELS } from "@/lib/agent/models";

export async function GET() {
  const envModel = process.env.OPENAI_MODEL?.trim();
  return Response.json({
    defaultModel: envModel || DEFAULT_MODEL,
    providers: {
      openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
      anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    },
    models: AGENT_MODELS,
    thinkingLevels: THINKING_LEVELS,
  });
}

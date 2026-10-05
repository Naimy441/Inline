import { z } from "zod";
import { COMMAND_NAME, mergeCommands, type SlashCommand } from "@/lib/agent/commands";
import { json, readJson, route } from "@/lib/server/http";
import { readSettingsFile, writeSettingsFile } from "@/lib/server/store";

/** The panel's slash commands: built-in ones plus the user's own. */

async function custom(): Promise<SlashCommand[]> {
  const stored = await readSettingsFile<{ commands?: SlashCommand[] }>("commands");
  return Array.isArray(stored?.commands) ? stored.commands : [];
}

export const GET = route(async () => json({ commands: mergeCommands(await custom()) }));

const Body = z.object({
  commands: z
    .array(
      z.object({
        name: z.string().regex(COMMAND_NAME, "Command names use lowercase letters, numbers and dashes."),
        description: z.string().trim().max(120),
        prompt: z.string().trim().min(1).max(20_000),
      }),
    )
    .max(100),
});

/** Replace the user's own commands. */
export const PUT = route(async (request) => {
  const body = await readJson(request, Body);
  const seen = new Set<string>();
  const commands = body.commands.filter((command) => !seen.has(command.name) && seen.add(command.name));
  await writeSettingsFile("commands", { commands });
  return json({ commands: mergeCommands(commands) });
});

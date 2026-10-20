import { codexAccount } from "@/lib/agent/codexAccount";
import { z } from "zod";
import { HttpError, json, readJson, route } from "@/lib/server/http";
import { claudeLogin } from "@/lib/server/claudeLogin";

/** Signing in to Claude Code from the Claude panel (see lib/server/claudeLogin.ts). */
export const GET = route(async (request) => json({ login: new URL(request.url).searchParams.get("provider") === "codex" ? codexAccount().loginStatus() : claudeLogin().status() }));

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("code"), code: z.string().min(1).max(4000) }),
  z.object({ action: z.literal("cancel") }),
]);

export const POST = route(async (request) => {
  const body = await readJson(request, Body);
  if (new URL(request.url).searchParams.get("provider") === "codex") {
    const account = codexAccount();
    if (body.action === "start") return json({ login: await account.startLogin() });
    if (body.action === "cancel") return json({ login: await account.cancelLogin() });
    throw new HttpError(400, "Complete Codex sign-in in your browser.");
  }
  const login = claudeLogin();
  if (body.action === "start") return json({ login: await login.start() });
  if (body.action === "code") {
    if (!login.submitCode(body.code)) throw new HttpError(409, "Start signing in first.");
    return json({ login: login.status() });
  }
  login.cancel();
  return json({ login: login.status() });
});

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/server/store";

/**
 * The secret MCP clients send to /api/mcp. It keeps other programs and other
 * users on the machine from editing documents through Inline's MCP server.
 *
 * Taken from INLINE_MCP_TOKEN when set ("off" turns the check off); otherwise
 * generated once and kept in $INLINE_DATA_DIR/mcp-token.
 */

let cached: { dir: string; token: string } | null = null;

export async function mcpToken(): Promise<string | null> {
  const fromEnv = process.env.INLINE_MCP_TOKEN?.trim();
  if (fromEnv) return fromEnv === "off" ? null : fromEnv;
  const dir = dataDir();
  if (cached?.dir === dir) return cached.token;
  const file = path.join(dir, "mcp-token");
  let token = (await readFile(file, "utf8").catch(() => "")).trim();
  if (!token) {
    token = randomBytes(24).toString("base64url");
    await mkdir(dir, { recursive: true });
    await writeFile(file, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(async () => {
      // Another request created it first; use theirs.
      token = (await readFile(file, "utf8")).trim();
    });
  }
  cached = { dir, token };
  return token;
}

function same(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Whether a request to /api/mcp carries the MCP token (or the Inline access token). */
export async function mcpAuthorized(request: Request) {
  const token = await mcpToken();
  if (!token) return true;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return false;
  const access = process.env.INLINE_ACCESS_TOKEN;
  return same(bearer, token) || Boolean(access && same(bearer, access));
}

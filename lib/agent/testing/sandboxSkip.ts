import { execFileSync } from "node:child_process";

/**
 * Claude Code's sandbox on Linux needs bubblewrap and socat. CI installs both
 * and must run the sandbox tests, so a missing tool fails there. On a laptop
 * without them the tests skip with the reason instead of failing.
 */
export function sandboxSkip(): string | false {
  if (process.env.CI || process.platform !== "linux") return false;
  const missing = ["bwrap", "socat"].filter((tool) => !hasCommand(tool));
  return missing.length ? `needs ${missing.join(" and ")} (sudo apt-get install bubblewrap socat)` : false;
}

function hasCommand(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

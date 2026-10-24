import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const port = 3199;
/** Where the server under test keeps its Word copies (see lib/server/mirror.ts). Set once, so test workers see the same folder. */
process.env.INLINE_E2E_MIRROR_DIR ??= path.join(os.tmpdir(), `inline-e2e-mirror-${Date.now()}`);
const MIRROR_DIR = process.env.INLINE_E2E_MIRROR_DIR;
// E2E_START=1 runs against `next start` (after `npm run build`), as CI does; otherwise a dev server.
const server = process.env.E2E_START ? `npx next start -p ${port}` : `npx next dev -p ${port}`;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  // Tiers, by tag. "@smoke" tests gate every PR. Untagged tests run on main and nightly.
  // "@quarantine" tests are known flaky: they leave the blocking run and run on
  // their own, non-blocking job. Tag one only with an owner in its annotation, and
  // open an issue for it. Never quarantine a test just to get a run green.
  // A retry in CI turns a flake green and marks it "flaky" in the report, so the
  // run stays honest and the trace of the first failure is kept for the fix.
  retries: process.env.CI ? 2 : 0,
  // Provider selection updates the app's defaults. Finish that suite (and
  // reset its defaults) before the other browser workers start.
  projects: [
    { name: "codex", testMatch: "**/codex.spec.ts" },
    { name: "regression", testIgnore: "**/codex.spec.ts", dependencies: ["codex"] },
  ],
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1440, height: 900 },
    trace: "on-first-retry",
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : undefined,
  },
  webServer: {
    command: server,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { INLINE_FAKE_CLAUDE: "1", INLINE_FAKE_CODEX: "1", INLINE_DATA_DIR: path.join(os.tmpdir(), `inline-e2e-${Date.now()}`), INLINE_MIRROR_DIR: MIRROR_DIR },
  },
});

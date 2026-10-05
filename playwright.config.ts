import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const port = 3199;
// E2E_START=1 runs against `next start` (after `npm run build`), as CI does; otherwise a dev server.
const server = process.env.E2E_START ? `npx next start -p ${port}` : `npx next dev -p ${port}`;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1440, height: 900 },
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : undefined,
  },
  webServer: {
    command: server,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { INLINE_FAKE_CLAUDE: "1", INLINE_DATA_DIR: path.join(os.tmpdir(), `inline-e2e-${Date.now()}`) },
  },
});

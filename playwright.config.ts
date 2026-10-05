import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const port = 3199;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1440, height: 900 },
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : undefined,
  },
  webServer: {
    command: `npx next dev -p ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { INLINE_DATA_DIR: path.join(os.tmpdir(), `inline-e2e-${Date.now()}`) },
  },
});

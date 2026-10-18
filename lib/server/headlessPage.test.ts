import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Browser } from "playwright";
import { launchPlaywrightChromium } from "./headlessPage";

const shellMissing = new Error("browserType.launch: Executable doesn't exist at /Users/naim/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell");

function fakeBrowser() {
  return { isConnected: () => true } as Browser;
}

describe("layout browser", () => {
  const savedPath = process.env.CHROMIUM_PATH;
  beforeEach(() => {
    delete process.env.CHROMIUM_PATH;
  });
  afterEach(() => {
    if (savedPath === undefined) delete process.env.CHROMIUM_PATH;
    else process.env.CHROMIUM_PATH = savedPath;
  });

  test("a missing headless shell launches the Chromium Playwright already installed", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "inline-chromium-"));
    const executable = path.join(folder, "chrome");
    writeFileSync(executable, "");
    const calls: Array<{ executablePath?: string }> = [];
    const browser = await launchPlaywrightChromium(
      {
        launch: async (options) => {
          calls.push(options);
          if (options.executablePath !== executable) throw shellMissing;
          return fakeBrowser();
        },
        executablePath: () => executable,
      },
      async () => {
        throw new Error("install should not run when the project browser is present");
      },
    );
    assert.equal(browser.isConnected(), true);
    assert.equal(calls.at(-1)?.executablePath, executable);
    assert.ok(calls.every((call) => !("channel" in call)));
  });

  test("installs this project's Playwright browser when no shell or recorded binary exists", async () => {
    let installed = false;
    const calls: Array<{ executablePath?: string }> = [];
    const browser = await launchPlaywrightChromium(
      {
        launch: async (options) => {
          calls.push(options);
          if (!installed) throw shellMissing;
          return fakeBrowser();
        },
        executablePath: () => path.join(tmpdir(), "missing-playwright-chrome", "chrome"),
      },
      async () => {
        installed = true;
      },
    );
    assert.equal(installed, true);
    assert.equal(browser.isConnected(), true);
    assert.equal(calls.at(-1)?.executablePath, undefined);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextFromReport, contextView, formatContextTokens, type ContextUsageReport } from "@/lib/agent/contextUsage";

const WINDOW = 1_000_000;

function report(overrides: Partial<ContextUsageReport> = {}): ContextUsageReport {
  return {
    totalTokens: 462_800,
    maxTokens: 200_000,
    rawMaxTokens: WINDOW,
    isAutoCompactEnabled: false,
    categories: [
      { name: "System prompt", tokens: 12_300, color: "blue", kind: "used" },
      { name: "System tools", tokens: 45_200, color: "cyan", kind: "used" },
      { name: "MCP tools", tokens: 61_700, color: "purple", kind: "used" },
      { name: "Skills", tokens: 8_100, color: "green", kind: "used" },
      { name: "Memory files", tokens: 15_400, color: "yellow", kind: "used" },
      { name: "Messages", tokens: 320_100, color: "orange", kind: "used" },
      { name: "Free space", tokens: 537_200, color: "gray", kind: "free" },
    ],
    memoryFiles: [
      { path: "/workspace/AGENTS.md", type: "Project", tokens: 9_200 },
      { path: "/workspace/CLAUDE.md", type: "Project", tokens: 6_200 },
    ],
    ...overrides,
  };
}

describe("context breakdown", () => {
  it("formats the model's window the way the panel prints it", () => {
    assert.equal(formatContextTokens(462_800), "462.8k");
    assert.equal(formatContextTokens(1_000_000), "1M");
    assert.equal(formatContextTokens(200_000), "200k");
    assert.equal(formatContextTokens(8_100), "8.1k");
    assert.equal(formatContextTokens(900), "900");
  });

  it("splits the open chat across the rows Claude reported, against the model's window", () => {
    const view = contextView(contextFromReport(report()));
    assert.ok(view);
    assert.equal(view.percentLabel, "46.3%");
    assert.equal(view.usageLabel, "462.8k / 1M");
    assert.equal(view.windowTokens, WINDOW);
    assert.deepEqual(
      view.rows.map((row) => [row.name, row.tokenLabel, row.percentLabel]),
      [
        ["Messages", "320.1k", "32%"],
        ["System tools", "45.2k", "4.5%"],
        ["System prompt", "12.3k", "1.2%"],
        ["Skills", "8.1k", "0.8%"],
        ["Memory files", "15.4k", "1.5%"],
        ["MCP tools", "61.7k", "6.2%"],
        ["Free space", "537.2k", "53.7%"],
      ],
    );
    assert.deepEqual(
      view.rows.find((row) => row.name === "Memory files")?.files?.map((file) => [file.name, file.tokenLabel]),
      [
        ["AGENTS.md", "9.2k"],
        ["CLAUDE.md", "6.2k"],
      ],
    );
    assert.deepEqual(
      view.bar.map((segment) => segment.name),
      ["Messages", "System tools", "System prompt", "Skills", "Memory files", "MCP tools"],
    );
    const filled = view.bar.reduce((sum, segment) => sum + segment.share, 0);
    assert.ok(Math.abs(filled - 462_800 / WINDOW) < 1e-9);
    assert.equal(view.rows.find((row) => row.name === "Free space")?.kind, "free");
    assert.equal(view.rows.find((row) => row.name === "Free space")?.color, "");
  });

  it("leaves out an autocompact buffer unless the session reserves one", () => {
    const withheld = contextView(
      contextFromReport(
        report({
          isAutoCompactEnabled: false,
          categories: [...(report().categories ?? []), { name: "Autocompact buffer", tokens: 33_000, color: "red", kind: "buffer" }],
        }),
      ),
    );
    assert.ok(withheld);
    assert.equal(withheld.rows.some((row) => row.kind === "buffer"), false);
    assert.equal(withheld.bar.some((segment) => segment.name === "Autocompact buffer"), false);

    const reserved = contextView(
      contextFromReport(
        report({
          isAutoCompactEnabled: true,
          totalTokens: 462_800,
          categories: [
            ...(report().categories ?? []).filter((category) => category.kind !== "free"),
            { name: "Autocompact buffer", tokens: 33_000, color: "gray", kind: "buffer" },
            { name: "Free space", tokens: 504_200, color: "gray", kind: "free" },
          ],
        }),
      ),
    );
    assert.ok(reserved);
    const buffer = reserved.rows.find((row) => row.name === "Autocompact buffer");
    assert.equal(buffer?.kind, "buffer");
    assert.equal(buffer?.tokenLabel, "33k");
    assert.deepEqual(reserved.rows.slice(-2).map((row) => row.name), ["Free space", "Autocompact buffer"]);
    assert.ok(reserved.bar.some((segment) => segment.name === "Autocompact buffer"));
    assert.equal(reserved.bar.some((segment) => segment.name === "Free space"), false);
  });

  it("leaves out deferred tools unless some are held out of the prompt", () => {
    const loaded = contextView(
      contextFromReport(
        report({
          categories: [...(report().categories ?? []), { name: "MCP tools (deferred)", tokens: 0, color: "purple", kind: "deferred" }],
          mcpTools: [{ name: "inline__read_document", tokens: 400, isLoaded: true }],
        }),
      ),
    );
    assert.ok(loaded);
    assert.equal(loaded.rows.some((row) => row.kind === "deferred"), false);

    const heldOut = contextView(
      contextFromReport(
        report({
          categories: [...(report().categories ?? []), { name: "MCP tools (deferred)", tokens: 20_800, color: "purple", kind: "deferred", isDeferred: true }],
        }),
      ),
    );
    assert.ok(heldOut);
    const deferred = heldOut.rows.find((row) => row.kind === "deferred");
    assert.equal(deferred?.name, "MCP tools (deferred)");
    assert.equal(deferred?.tokenLabel, "20.8k");
    assert.equal(heldOut.rows.at(-1)?.kind, "deferred");
    assert.equal(heldOut.bar.some((segment) => segment.name === "MCP tools (deferred)"), false);
  });

  it("adds a deferred row from tools the report held out when it has no deferred category", () => {
    const view = contextView(
      contextFromReport(
        report({
          mcpTools: [{ name: "inline__read_document", tokens: 2_400, isLoaded: false }],
          deferredBuiltinTools: [{ name: "Bash", tokens: 1_100, isLoaded: false }],
        }),
      ),
    );
    assert.equal(view?.rows.find((row) => row.kind === "deferred")?.tokenLabel, "3.5k");
    assert.equal(view?.bar.some((segment) => segment.name === "Deferred tools"), false);
  });

  it("does not invent a category the report does not have", () => {
    const view = contextView(
      contextFromReport({
        totalTokens: 20_000,
        rawMaxTokens: 200_000,
        maxTokens: 200_000,
        isAutoCompactEnabled: false,
        categories: [{ name: "Messages", tokens: 20_000, color: "orange", kind: "used" }],
      }),
    );
    assert.deepEqual(
      view?.rows.map((row) => row.name),
      ["Messages", "Free space"],
    );
    assert.equal(view?.rows.find((row) => row.name === "Free space")?.tokenLabel, "180k");
    assert.equal(view?.rows.some((row) => row.files), false);
  });

  it("does not draw a breakdown from totals alone", () => {
    assert.equal(contextView(undefined), null);
    assert.equal(contextView(null), null);
    const totals = contextFromReport({ totalTokens: 24_000, maxTokens: 200_000, rawMaxTokens: 200_000 });
    assert.deepEqual(totals, { tokens: 24_000, maxTokens: 200_000, percentage: 12 });
    assert.equal(contextView(totals), null);
    assert.equal(contextFromReport(null), null);
    assert.equal(contextFromReport({ totalTokens: 10, maxTokens: 0, rawMaxTokens: 0 }), null);
  });

  it("lists each memory file that is in the prompt, and disambiguates shared names", () => {
    const view = contextView(
      contextFromReport(
        report({
          memoryFiles: [
            { path: "/workspace/AGENTS.md", type: "Project", tokens: 9_200 },
            { path: "/other/AGENTS.md", type: "User", tokens: 6_200 },
          ],
        }),
      ),
    );
    assert.deepEqual(
      view?.rows.find((row) => row.name === "Memory files")?.files?.map((file) => [file.name, file.tokens]),
      [
        ["workspace/AGENTS.md", 9_200],
        ["other/AGENTS.md", 6_200],
      ],
    );
  });
});

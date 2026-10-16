import type { ContextCategory, ContextCategoryKind, ContextMemoryFile, ContextUsage } from "@/lib/agent/types";

/**
 * Claude Code's context report (`getContextUsage`), narrowed to the fields
 * Inline shows. Extra fields are ignored.
 */
export type ContextUsageReport = {
  categories?: Array<{
    name?: string;
    tokens?: number;
    color?: string;
    isDeferred?: boolean;
    kind?: string;
  }>;
  totalTokens?: number;
  maxTokens?: number;
  rawMaxTokens?: number;
  isAutoCompactEnabled?: boolean;
  memoryFiles?: Array<{ path?: string; type?: string; tokens?: number }>;
  mcpTools?: Array<{ name?: string; tokens?: number; isLoaded?: boolean }>;
  deferredBuiltinTools?: Array<{ name?: string; tokens?: number; isLoaded?: boolean }>;
};

const NAMED_COLORS: Record<string, string> = {
  blue: "#5b7cfa",
  cyan: "#2a9d9a",
  teal: "#2a9d9a",
  green: "#3d9a5f",
  yellow: "#c8962e",
  amber: "#c8962e",
  orange: "#e08a3c",
  red: "#d4656a",
  purple: "#9a6ad4",
  magenta: "#9a6ad4",
  pink: "#d46a9a",
  gray: "#8e8a82",
  grey: "#8e8a82",
};

const FALLBACK_COLORS: Record<string, string> = {
  messages: "#e08a3c",
  "system-tools": "#2a9d9a",
  "system-prompt": "#5b7cfa",
  skills: "#3d9a5f",
  memory: "#c8962e",
  "mcp-tools": "#9a6ad4",
  agents: "#d46a9a",
  buffer: "#8e8a82",
  deferred: "#8e8a82",
};

/** The named rows, in the order the panel lists them. Anything else real sits after these. */
const NAMED_ORDER = ["messages", "system-tools", "system-prompt", "skills", "memory"];

type Draft = ContextCategory & { key: string; index: number };

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function categoryKind(category: { name?: string; kind?: string; isDeferred?: boolean }): ContextCategoryKind {
  if (category.kind === "used" || category.kind === "free" || category.kind === "buffer" || category.kind === "deferred") return category.kind;
  if (category.isDeferred) return "deferred";
  const name = (category.name ?? "").toLowerCase();
  if (name.includes("free")) return "free";
  if (name.includes("autocompact") || name.includes("compact buffer")) return "buffer";
  if (name.includes("deferred")) return "deferred";
  return "used";
}

function categoryKey(name: string, kind: ContextCategoryKind): string {
  if (kind === "free") return "free";
  if (kind === "buffer") return "buffer";
  if (kind === "deferred") return "deferred";
  const normalized = name.toLowerCase();
  if (normalized.includes("message")) return "messages";
  if (normalized.includes("system tool")) return "system-tools";
  if (normalized.includes("system prompt")) return "system-prompt";
  if (normalized.includes("skill")) return "skills";
  if (normalized.includes("memory")) return "memory";
  if (normalized.includes("mcp")) return "mcp-tools";
  if (normalized.includes("agent")) return "agents";
  return `other:${normalized}`;
}

function cssColor(color: string | undefined, key: string): string {
  const trimmed = color?.trim() ?? "";
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(trimmed)) return trimmed;
  if (/^(?:rgb|hsl)a?\(/i.test(trimmed)) return trimmed;
  const named = NAMED_COLORS[trimmed.toLowerCase()];
  if (named) return named;
  return FALLBACK_COLORS[key] ?? "#8e8a82";
}

function memoryFilesFrom(report: ContextUsageReport): ContextMemoryFile[] {
  if (!Array.isArray(report.memoryFiles)) return [];
  const files: ContextMemoryFile[] = [];
  for (const file of report.memoryFiles) {
    const tokens = finite(file?.tokens);
    if (typeof file?.path !== "string" || !file.path || tokens <= 0) continue;
    files.push({ path: file.path, tokens });
  }
  return files;
}

function deferredToolTokens(report: ContextUsageReport): number {
  const mcp = (report.mcpTools ?? []).reduce((sum, tool) => sum + (tool?.isLoaded === false ? Math.max(0, finite(tool.tokens)) : 0), 0);
  const builtin = (report.deferredBuiltinTools ?? []).reduce((sum, tool) => sum + (tool?.isLoaded === false ? Math.max(0, finite(tool.tokens)) : 0), 0);
  return mcp + builtin;
}

function sortRank(category: Draft): [number, number] {
  if (category.kind === "free") return [100, category.index];
  if (category.kind === "buffer") return [110, category.index];
  if (category.kind === "deferred") return [120, category.index];
  const named = NAMED_ORDER.indexOf(category.key);
  if (named >= 0) return [named, category.index];
  return [50, category.index];
}

/**
 * The breakdown to store for a chat. Totals alone are kept for the usage
 * meter. Categories are only the ones the report actually contains: no
 * autocompact buffer unless this session reserves one, and no deferred tools
 * unless some are held out of the prompt.
 */
export function contextFromReport(report: ContextUsageReport | null | undefined): ContextUsage | null {
  if (!report) return null;
  const maxTokens = finite(report.rawMaxTokens) || finite(report.maxTokens);
  if (maxTokens <= 0) return null;
  const tokens = Math.max(0, finite(report.totalTokens));
  const percentage = Math.round((tokens / maxTokens) * 1000) / 10;
  const memoryFiles = memoryFilesFrom(report);
  const fileTokens = memoryFiles.reduce((sum, file) => sum + file.tokens, 0);
  const incoming = Array.isArray(report.categories) ? report.categories : [];
  if (!incoming.length && fileTokens <= 0) return { tokens, maxTokens, percentage };

  const drafts: Draft[] = [];
  incoming.forEach((category, index) => {
    const name = category?.name?.trim() ?? "";
    if (!name) return;
    const kind = categoryKind(category);
    const key = categoryKey(name, kind);
    let categoryTokens = Math.max(0, finite(category.tokens));
    if (kind === "buffer" && (report.isAutoCompactEnabled === false || categoryTokens <= 0)) return;
    if (kind === "deferred" && categoryTokens <= 0) return;
    if (kind === "used" && key === "memory" && categoryTokens <= 0 && fileTokens > 0) categoryTokens = fileTokens;
    if (kind === "used" && categoryTokens <= 0) return;
    drafts.push({
      name,
      tokens: categoryTokens,
      kind,
      key,
      index,
      color: kind === "free" ? "" : cssColor(category.color, key),
    });
  });

  if (fileTokens > 0 && !drafts.some((category) => category.key === "memory")) {
    drafts.push({ name: "Memory files", tokens: fileTokens, kind: "used", key: "memory", index: incoming.length, color: cssColor(undefined, "memory") });
  }

  const deferred = deferredToolTokens(report);
  if (deferred > 0 && !drafts.some((category) => category.kind === "deferred")) {
    drafts.push({ name: "Deferred tools", tokens: deferred, kind: "deferred", key: "deferred", index: incoming.length + 1, color: cssColor(undefined, "deferred") });
  }

  const usedTokens = drafts.filter((category) => category.kind === "used").reduce((sum, category) => sum + category.tokens, 0);
  const bufferTokens = drafts.filter((category) => category.kind === "buffer").reduce((sum, category) => sum + category.tokens, 0);
  if (!drafts.some((category) => category.kind === "free") && usedTokens > 0) {
    drafts.push({ name: "Free space", tokens: Math.max(0, maxTokens - usedTokens - bufferTokens), kind: "free", key: "free", index: incoming.length + 2, color: "" });
  }

  if (!drafts.length) return { tokens, maxTokens, percentage };
  drafts.sort((a, b) => {
    const [aRank, aIndex] = sortRank(a);
    const [bRank, bIndex] = sortRank(b);
    return aRank - bRank || aIndex - bIndex;
  });
  const categories = drafts.map(({ name, tokens: categoryTokens, kind, color }) => ({ name, tokens: categoryTokens, kind, color }));
  return { tokens, maxTokens, percentage, categories, ...(memoryFiles.length ? { memoryFiles } : {}) };
}

/** 462800 → "462.8k", 1000000 → "1M", 900 → "900". */
export function formatContextTokens(count: number): string {
  const sign = count < 0 ? "-" : "";
  const abs = Math.abs(count);
  if (abs >= 1_000_000) return `${sign}${compact(abs / 1_000_000)}M`;
  if (abs >= 1000) return `${sign}${compact(abs / 1000)}k`;
  return `${sign}${Math.round(abs)}`;
}

function compact(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

/** 46.28 → "46.3%", 12 → "12%", a trace above zero → "<0.1%". */
export function formatContextPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  const rounded = Math.round(value * 10) / 10;
  if (rounded < 0.1) return "<0.1%";
  return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)}%`;
}

export type ContextViewFile = { name: string; path: string; tokens: number; tokenLabel: string };

export type ContextViewRow = {
  name: string;
  tokens: number;
  tokenLabel: string;
  percentLabel: string;
  color: string;
  kind: ContextCategoryKind;
  files?: ContextViewFile[];
};

export type ContextBarSegment = { name: string; color: string; share: number };

export type ContextView = {
  percentLabel: string;
  usageLabel: string;
  tokens: number;
  windowTokens: number;
  rows: ContextViewRow[];
  /** Used categories, and the autocompact buffer when one is reserved. Free space is the unfilled rest. */
  bar: ContextBarSegment[];
};

/** The file name as the row shows it. Two files with the same name keep their parent folder. */
export function memoryFileName(filePath: string, paths: string[]): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  const base = parts.at(-1) ?? filePath;
  const same = paths.filter((item) => (item.split(/[\\/]/).filter(Boolean).at(-1) ?? item) === base);
  if (same.length <= 1) return base;
  const parent = parts.at(-2);
  return parent ? `${parent}/${base}` : base;
}

/** The panel's view of a stored breakdown. Totals with no categories are not a view. */
export function contextView(usage: ContextUsage | null | undefined): ContextView | null {
  if (!usage || !(usage.maxTokens > 0) || !usage.categories?.length) return null;
  const windowTokens = usage.maxTokens;
  const paths = (usage.memoryFiles ?? []).map((file) => file.path);
  const files: ContextViewFile[] = (usage.memoryFiles ?? []).map((file) => ({
    name: memoryFileName(file.path, paths),
    path: file.path,
    tokens: file.tokens,
    tokenLabel: formatContextTokens(file.tokens),
  }));
  let attached = false;
  const rows: ContextViewRow[] = usage.categories.map((category) => {
    const row: ContextViewRow = {
      name: category.name,
      tokens: category.tokens,
      tokenLabel: formatContextTokens(category.tokens),
      percentLabel: formatContextPercent((category.tokens / windowTokens) * 100),
      color: category.color,
      kind: category.kind,
    };
    if (!attached && category.kind === "used" && /memory/i.test(category.name) && files.length) {
      row.files = files;
      attached = true;
    }
    return row;
  });
  const bar = rows
    .filter((row) => (row.kind === "used" || row.kind === "buffer") && row.tokens > 0 && row.color)
    .map((row) => ({ name: row.name, color: row.color, share: row.tokens / windowTokens }));
  return {
    percentLabel: formatContextPercent((usage.tokens / windowTokens) * 100),
    usageLabel: `${formatContextTokens(usage.tokens)} / ${formatContextTokens(windowTokens)}`,
    tokens: usage.tokens,
    windowTokens,
    rows,
    bar,
  };
}

import path from "node:path";

/**
 * Claude Code plugin that ships the page-layout skill. The agent's working
 * directory is the data folder, so this path is absolute. The desktop build
 * traces the directory into the standalone server (next.config.mjs).
 */
export const PAGE_LAYOUT_PLUGIN_DIR = path.join(process.cwd(), "lib", "agent", "skills", "page-layout");

/** Skill name in that plugin: the SKILL.md `name` and its directory name. */
export const PAGE_LAYOUT_SKILL = "page-layout";

/** Canvas tools. On a Markdown turn these are deferred so their schemas are not sent until a search loads them. */
export const CANVAS_TOOL_NAMES = [
  "read_canvas",
  "create_canvas",
  "get_canvas_guide",
  "patch_canvas",
  "inspect_canvas",
  "check_layout",
  "switch_to_unrestricted_canvas",
  "read_unrestricted_canvas",
  "write_unrestricted_canvas",
  "screenshot_unrestricted_canvas",
] as const;

/**
 * Tools that stay in the prompt on a Canvas turn: the canvas tools, the
 * document folder, the page screenshot, and background jobs.
 */
const CANVAS_TURN_TOOLS = new Set<string>([
  ...CANVAS_TOOL_NAMES,
  "list_files",
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
  "run_command",
  "screenshot_page",
  "start_job",
  "get_job",
  "stop_job",
  "start_jobs",
]);

const CANVAS_TOOLS = new Set<string>(CANVAS_TOOL_NAMES);

/** Whether this tool's schema is sent on every turn. The other tools stay registered, with a search hint, so tool search can load them. */
export function toolIsAlwaysLoaded(name: string, canvas: boolean): boolean {
  if (canvas) return CANVAS_TURN_TOOLS.has(name);
  return !CANVAS_TOOLS.has(name);
}

/** A short hint for a deferred tool, so tool search can find it without the full schema. */
export function deferredSearchHint(tool: { name: string; description: string }): string {
  const sentence = tool.description.split(/(?<=\.)\s/)[0] ?? tool.description;
  const hint = `${tool.name}: ${sentence}`;
  return hint.length > 240 ? `${hint.slice(0, 237)}...` : hint;
}

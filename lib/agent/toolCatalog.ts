export type AgentToolName =
  | "get_outline"
  | "search_document"
  | "read_document"
  | "replace_text"
  | "insert_text"
  | "delete_text"
  | "propose_tasks"
  | "set_chat_title"
  | "seed_document"
  | "lint_writing"
  | "count_words"
  | "detect_ai_tropes"
  | "retrieve_passages"
  | "search_citations"
  | "web_search"
  | "web_fetch"
  | "run_code"
  | "export_pdf"
  | "undo"
  | "redo"
  | "insert_link"
  | "insert_image"
  | "highlight_text"
  | "set_font_size"
  | "set_font_family"
  | "set_text_color"
  | "toggle_list"
  | "toggle_bold"
  | "toggle_italic"
  | "toggle_underline"
  | "add_header"
  | "add_footer"
  | "add_page_numbers"
  | "set_alignment"
  | "set_line_spacing"
  | "set_block_style"
  | "set_paragraph_indent"
  | "apply_paper_style"
  | "insert_table"
  | "insert_page_break"
  | "indent_blocks"
  | "insert_horizontal_line";

export type AgentToolCall = {
  id: string;
  name: AgentToolName;
  args: Record<string, unknown>;
  hidden?: boolean;
};

export type AgentToolResult = {
  id: string;
  name: AgentToolName;
  result: unknown;
  hidden?: boolean;
};

export const DOCUMENT_TOOLS: AgentToolName[] = [
  "get_outline",
  "search_document",
  "read_document",
  "replace_text",
  "insert_text",
  "delete_text",
  "propose_tasks",
  "set_chat_title",
  "seed_document",
];

export const SERVER_TOOLS: AgentToolName[] = [
  "lint_writing",
  "count_words",
  "detect_ai_tropes",
  "retrieve_passages",
  "search_citations",
  "web_search",
  "web_fetch",
  "run_code",
];

export const CLIENT_TOOLS: AgentToolName[] = [
  "export_pdf",
  "undo",
  "redo",
  "insert_link",
  "insert_image",
  "highlight_text",
  "set_font_size",
  "set_font_family",
  "set_text_color",
  "toggle_list",
  "toggle_bold",
  "toggle_italic",
  "toggle_underline",
  "add_header",
  "add_footer",
  "add_page_numbers",
  "set_alignment",
  "set_line_spacing",
  "set_block_style",
  "set_paragraph_indent",
  "apply_paper_style",
  "insert_table",
  "insert_page_break",
  "indent_blocks",
  "insert_horizontal_line",
];

export const ALL_TOOL_NAMES: AgentToolName[] = [...DOCUMENT_TOOLS, ...SERVER_TOOLS, ...CLIENT_TOOLS];

export function isToolName(value: unknown): value is AgentToolName {
  return typeof value === "string" && ALL_TOOL_NAMES.includes(value as AgentToolName);
}

export function isServerTool(name: AgentToolName) {
  return SERVER_TOOLS.includes(name);
}

export function isClientTool(name: AgentToolName) {
  return CLIENT_TOOLS.includes(name);
}

export function isDocumentTool(name: AgentToolName) {
  return DOCUMENT_TOOLS.includes(name);
}

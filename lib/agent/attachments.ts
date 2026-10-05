import { docxToDoc } from "@/lib/doc/docxImport";
import { docToMarkdown } from "@/lib/doc/markdown";
import { readZip } from "@/lib/server/unzip";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** The text Claude reads for a non-image, non-PDF attachment. Word files are converted to Inline's Markdown. */
export async function attachmentText(extension: string, data: Buffer) {
  if (extension === "docx") {
    try {
      const parts = readZip(new Uint8Array(data));
      return docToMarkdown(await docxToDoc(parts));
    } catch (error) {
      return `[This Word file couldn't be read: ${errorText(error)}]`;
    }
  }
  return data.toString("utf8");
}


import { json, notFound, route, routeDocument } from "@/lib/server/http";
import { listWorkspaceFiles, readWorkspaceBytes } from "@/lib/server/repo";

type Context = { params: Promise<{ id: string; path?: string[] }> };

/** List the document's folder, or return one file from it (a chart, a script). */
export const GET = route(async (_request, context: Context) => {
  const doc = await routeDocument(context);
  const { path: parts } = await context.params;
  if (!parts?.length) return json({ files: await listWorkspaceFiles(doc.id) });
  let file;
  try {
    file = await readWorkspaceBytes(doc.id, parts.map((part) => decodeURIComponent(part)).join("/"));
  } catch {
    throw notFound("File not found.");
  }
  if (file.data.byteLength > 15 * 1024 * 1024) throw notFound("File not found.");
  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.mime,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
});

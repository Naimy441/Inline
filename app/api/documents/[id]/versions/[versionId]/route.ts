import { docToMarkdown } from "@/lib/doc/markdown";
import { loadDoc } from "@/lib/server/hub";
import { json, notFound, route, routeDocument } from "@/lib/server/http";
import { readDocumentVersion } from "@/lib/server/repo";

type Context = { params: Promise<{ id: string; versionId: string }> };

export const GET = route(async (_request, context: Context) => {
  const doc = await routeDocument(context);
  const { versionId } = await context.params;
  const version = await readDocumentVersion(doc.id, versionId);
  if (!version) throw notFound("Version not found.");
  return json({ version: { ...version, markdown: docToMarkdown(loadDoc(version.doc)) } });
});

export const DELETE = route(async () => {
  return json({ error: "A saved version stays in the history. Restore an earlier one instead." }, { status: 400 });
});

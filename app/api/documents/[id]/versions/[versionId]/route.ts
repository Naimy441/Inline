import { docToMarkdown } from "@/lib/doc/markdown";
import { loadDoc } from "@/lib/server/hub";
import { json, notFound, route, routeDocument } from "@/lib/server/http";
import { deleteVersion, readVersion } from "@/lib/server/store";

type Context = { params: Promise<{ id: string; versionId: string }> };

export const GET = route(async (_request, context: Context) => {
  const doc = await routeDocument(context);
  const { versionId } = await context.params;
  const version = await readVersion(doc.id, versionId);
  if (!version) throw notFound("Version not found.");
  return json({ version: { ...version, markdown: docToMarkdown(loadDoc(version.doc)) } });
});

export const DELETE = route(async (_request, context: Context) => {
  const doc = await routeDocument(context);
  const { versionId } = await context.params;
  await deleteVersion(doc.id, versionId);
  return json({ ok: true });
});

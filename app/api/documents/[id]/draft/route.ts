import { docWordCount } from "@/lib/doc/editing";
import { loadDoc } from "@/lib/server/hub";
import { json, route, routeDocument } from "@/lib/server/http";
import { readDraft } from "@/lib/server/repo";

type Context = { params: Promise<{ id: string }> };

/** The revision Claude prepared beside the document, if there is one. */
export const GET = route(async (_request, context: Context) => {
  const doc = await routeDocument(context);
  const draft = await readDraft(doc.id);
  if (!draft) return json({ draft: null });
  const node = loadDoc(draft.doc);
  return json({ draft: { updatedAt: draft.updatedAt, words: docWordCount(node), doc: draft.doc } });
});

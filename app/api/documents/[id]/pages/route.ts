import { documentPages } from "@/lib/agent/references";
import { json, route, routeDocument } from "@/lib/server/http";

type Context = { params: Promise<{ id: string }> };

/** The pages a user can pick when linking this document as a writing sample. */
export const GET = route(async (_request, context: Context) => {
  const doc = await routeDocument(context);
  const { pages, measured } = documentPages(doc);
  return json({
    measured,
    pages: pages.map((page) => ({ number: page.number, words: page.words, preview: page.preview })),
  });
});

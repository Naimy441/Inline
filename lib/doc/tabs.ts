import type { Node as PMNode } from "prosemirror-model";
import { schema } from "@/lib/doc/schema";

/** A document's tabs as one document for export, each tab starting on a new page. */
export function joinTabs(docs: PMNode[]) {
  if (docs.length === 1) return docs[0]!;
  const blocks: PMNode[] = [];
  docs.forEach((doc, index) => {
    if (index) blocks.push(schema.nodes.page_break!.create());
    doc.forEach((block) => blocks.push(block));
  });
  return schema.nodes.doc!.create(null, blocks);
}

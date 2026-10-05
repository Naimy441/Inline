import type { Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newId(length = 8): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/**
 * Returns the steps needed to give every id-carrying block a unique id.
 * Blocks copied by split/paste keep their original id, so duplicates are
 * re-keyed (the later one gets a new id) as well as missing ids filled in.
 */
export function blockIdFixes(doc: PMNode): Transform | null {
  const seen = new Set<string>();
  const fixes: Array<{ pos: number; id: string }> = [];
  doc.descendants((node, pos) => {
    if (!node.isBlock) return false;
    if (!("id" in node.attrs)) return true;
    const id = node.attrs.id as string | null;
    if (!id || seen.has(id)) {
      const next = uniqueId(seen);
      seen.add(next);
      fixes.push({ pos, id: next });
    } else {
      seen.add(id);
    }
    // Ids are only needed on blocks the agent and UI address: top level, plus list/quote children.
    return node.type.name === "blockquote" || node.type.name === "doc";
  });
  if (!fixes.length) return null;
  const tr = new Transform(doc);
  for (const fix of fixes) tr.setNodeAttribute(fix.pos, "id", fix.id);
  return tr;
}

export function ensureBlockIds(doc: PMNode): PMNode {
  return blockIdFixes(doc)?.doc ?? doc;
}

function uniqueId(seen: Set<string>) {
  let id = newId();
  while (seen.has(id)) id = newId();
  return id;
}

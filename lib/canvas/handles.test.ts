import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blockDropDest, type BlockSlot } from "@/lib/canvas/handles";

const slots: BlockSlot[] = [
  { pos: 0, size: 10, top: 0, bottom: 100, left: 40 },
  { pos: 10, size: 10, top: 110, bottom: 210, left: 40 },
];

describe("blockDropDest", () => {
  it("lands before a block when the pointer is in its top half", () => {
    assert.equal(blockDropDest(slots, 40, 10, 10), 0);
  });

  it("lands after the last block when the pointer passes its middle", () => {
    assert.equal(blockDropDest(slots, 180, 0, 10), 20);
  });

  it("is not a destination when the block would stay where it is", () => {
    assert.equal(blockDropDest(slots, 20, 0, 10), null);
    assert.equal(blockDropDest(slots, 80, 10, 10), null);
    assert.equal(blockDropDest(slots, 200, 10, 10), null);
  });
});

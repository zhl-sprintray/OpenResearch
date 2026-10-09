import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveMinimapItems,
  minimapCurrentIndex,
  minimapHitStripWidth,
  minimapIndexFromPointer,
} from "../src/transcriptMinimap.ts";

const text = (value, phase) => ({ id: value, type: "text", text: value, phase });

test("each user turn previews its last final answer", () => {
  const items = deriveMinimapItems([
    { id: "u1", role: "user", parts: [text("first   question")] },
    { id: "a1", role: "assistant", parts: [text("working", "commentary"), text("draft")] },
    { id: "a2", role: "assistant", parts: [text("final answer")] },
    { id: "shell", role: "user", parts: [{ id: "t", type: "tool", tool: "shell" }] },
    { id: "u2", role: "user", parts: [text("second")] },
  ]);
  assert.deepEqual(items, [
    { id: "u1", index: 0, userText: "first question", assistantText: "final answer" },
    { id: "u2", index: 4, userText: "second", assistantText: "" },
  ]);
});

test("the current turn is the first in view, else the last scrolled past", () => {
  const bounds = [{ top: 0, height: 100 }, null, { top: 300, height: 100 }];
  assert.equal(minimapCurrentIndex(50, 250, bounds), 0);
  assert.equal(minimapCurrentIndex(250, 350, bounds), 2);
  assert.equal(minimapCurrentIndex(150, 250, bounds), 0);
});

test("pointer and gutter geometry stay in bounds", () => {
  assert.equal(minimapIndexFromPointer(5, 100, 40, 90), 0);
  assert.equal(minimapIndexFromPointer(5, 100, 40, 120), 2);
  assert.equal(minimapIndexFromPointer(5, 100, 40, 999), 4);
  assert.equal(minimapHitStripWidth(8), 0);
  assert.equal(minimapHitStripWidth(200), 40);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { appendLogTail, emptyLogTail, logTailLines } from "../src/logTail.ts";

const feed = (...chunks) => chunks.reduce((tail, chunk) => appendLogTail(tail, chunk), emptyLogTail);

test("keeps only the last 50 lines of a long log", () => {
  const text = Array.from({ length: 120 }, (_, index) => `line ${index + 1}\n`).join("");
  const lines = logTailLines(feed(text));
  assert.equal(lines.length, 50);
  assert.equal(lines[0], "line 71");
  assert.equal(lines.at(-1), "line 120");
});

test("joins a line split across chunks and shows the line still being written", () => {
  assert.deepEqual(logTailLines(feed("epoch 1 lo", "ss 0.5\nepoch 2")), ["epoch 1 loss 0.5", "epoch 2"]);
});

test("a carriage return overwrites the line, as a progress bar does in a terminal", () => {
  assert.deepEqual(
    logTailLines(feed("start\n", " 10%|#  \r", " 50%|#####\r100%|##########\n", "done\r\n")),
    ["start", "100%|##########", "done"],
  );
});

test("terminal colour codes are dropped", () => {
  assert.deepEqual(logTailLines(feed("\u001b[31mError:\u001b[0m bad\n", "\u001b[1;32mok")), ["Error: bad", "ok"]);
});

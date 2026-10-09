import assert from "node:assert/strict";
import { test } from "node:test";
import { initialMobileNav, mobileNavReducer, restorePanelStack } from "../src/mobileNav.ts";

const list = { kind: "experiments" };
const detail = { kind: "experiment", experimentId: "e1" };

test("the panel stack is kept while the route shows its top panel", () => {
  assert.deepEqual(restorePanelStack([list, detail], detail), [list, detail]);
});

test("a deep link to a detail panel restores its list underneath, so Back reaches the list", () => {
  assert.deepEqual(restorePanelStack([], detail), [list, detail]);
  const artifact = { kind: "artifact", path: "figs/loss.png" };
  assert.deepEqual(restorePanelStack([], artifact), [{ kind: "artifacts" }, artifact]);
  assert.deepEqual(restorePanelStack([], list), [list]);
  const plan = { kind: "plan", promptId: "p1" };
  assert.deepEqual(restorePanelStack([], plan), [plan]);
});

test("the chat (no panel in the route) has an empty stack", () => {
  assert.deepEqual(restorePanelStack([list, detail], null), []);
});

test("browser back to a panel lower in the stack drops the panels above it", () => {
  assert.deepEqual(restorePanelStack([list, detail], list), [list]);
});

test("switching runs keeps the experiment's place in the stack", () => {
  const run2 = { kind: "experiment", experimentId: "e1", runId: "r2" };
  assert.deepEqual(restorePanelStack([list, detail], run2), [list, run2]);
});

test("after browser back, the next panel opened stacks on what is shown, not on the panels left behind", () => {
  const other = { kind: "experiment", experimentId: "e2" };
  let state = [
    { type: "pushPanel", panel: list },
    { type: "pushPanel", panel: detail },
    { type: "routePanel", panel: list },
    { type: "pushPanel", panel: other },
  ].reduce(mobileNavReducer, initialMobileNav);
  assert.deepEqual(state.panels, [list, other]);
  state = mobileNavReducer(state, { type: "routePanel", panel: null });
  assert.deepEqual(state.panels, []);
});

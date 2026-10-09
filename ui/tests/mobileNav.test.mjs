import assert from "node:assert/strict";
import { test } from "node:test";
import { initialMobileNav, mobileNavReducer, mobilePaneView, panelToPane, pendingPrompts } from "../src/mobileNav.ts";

const run = (...events) => events.reduce(mobileNavReducer, initialMobileNav);

test("drawer opens and closes", () => {
  assert.equal(run({ type: "openDrawer" }).drawerOpen, true);
  assert.equal(run({ type: "openDrawer" }, { type: "closeDrawer" }).drawerOpen, false);
});

test("selecting a session closes the drawer and clears the panel stack", () => {
  const state = run(
    { type: "pushPanel", panel: { kind: "experiments" } },
    { type: "openDrawer" },
    { type: "selectSession" },
  );
  assert.deepEqual(state, { drawerOpen: false, newSession: null, panels: [] });
});

test("back pops one panel at a time and is a no-op on the chat", () => {
  const list = { kind: "experiments" };
  const detail = { kind: "experiment", experimentId: "e1", runId: "r2" };
  const both = run({ type: "pushPanel", panel: list }, { type: "pushPanel", panel: detail });
  assert.deepEqual(both.panels, [list, detail]);
  const back = mobileNavReducer(both, { type: "popPanel" });
  assert.deepEqual(back.panels, [list]);
  const chat = mobileNavReducer(back, { type: "popPanel" });
  assert.deepEqual(chat.panels, []);
  assert.deepEqual(mobileNavReducer(chat, { type: "popPanel" }), chat);
});

test("opening a panel closes the drawer", () => {
  const state = run({ type: "openDrawer" }, { type: "pushPanel", panel: { kind: "artifacts" } });
  assert.equal(state.drawerOpen, false);
});

test("new session page defaults to the current session's project and can switch project", () => {
  const opened = run({ type: "openDrawer" }, { type: "openNewSession", sessionProjectId: "p-session", routeProjectId: "p-route" });
  assert.deepEqual(opened.newSession, { open: true, projectId: "p-session" });
  assert.equal(opened.drawerOpen, false);
  const picked = mobileNavReducer(opened, { type: "pickNewSessionProject", projectId: "p-other" });
  assert.deepEqual(picked.newSession, { open: true, projectId: "p-other" });
  assert.equal(mobileNavReducer(picked, { type: "closeNewSession" }).newSession, null);
});

test("new session page falls back to the route's project when no session is open", () => {
  const opened = run({ type: "openNewSession", sessionProjectId: null, routeProjectId: "p-route" });
  assert.deepEqual(opened.newSession, { open: true, projectId: "p-route" });
});

test("sending the first message lands in the new session's chat", () => {
  const state = run({ type: "openNewSession", sessionProjectId: null, routeProjectId: "p" }, { type: "selectSession" });
  assert.equal(state.newSession, null);
});

test("crossing the breakpoint closes panels and the drawer", () => {
  const state = run(
    { type: "pushPanel", panel: { kind: "experiments" } },
    { type: "openDrawer" },
    { type: "viewportCrossed" },
  );
  assert.equal(state.drawerOpen, false);
  assert.deepEqual(state.panels, []);
});

test("mobile panels round-trip through the pane search param", () => {
  const cases = [
    [{ kind: "experiments" }, { kind: "home", view: "experiments" }],
    [{ kind: "experiment", experimentId: "e1" }, { kind: "experiment", experimentId: "e1", view: "overview" }],
    [{ kind: "experiment", experimentId: "e1", runId: "r1" }, { kind: "experiment", experimentId: "e1", view: "overview", runId: "r1" }],
    [{ kind: "artifacts" }, { kind: "home", view: "artifacts" }],
    [{ kind: "artifact", path: "fig/loss.png" }, { kind: "file", path: "fig/loss.png", source: "artifacts" }],
    [{ kind: "plan", promptId: "part-7" }, { kind: "plan", sessionId: "s1", promptId: "part-7" }],
    [{ kind: "subagent", partId: "part-9" }, { kind: "subagent", sessionId: "s1", spawnPartId: "part-9" }],
  ];
  for (const [panel, pane] of cases) {
    assert.deepEqual(panelToPane(panel, "s1"), pane);
    assert.deepEqual(mobilePaneView(pane), { kind: "panel", panel });
  }
});

test("files, diff, terminal and code edit panes are desktop only", () => {
  const desktopOnly = [
    { kind: "home", view: "files" },
    { kind: "home", view: "terminal" },
    { kind: "experiment", experimentId: "e1", view: "terminal" },
    { kind: "file", path: "train.py" },
    { kind: "file", path: "main.tex", source: "repo" },
    { kind: "file", path: "/etc/hosts", source: "abs" },
    { kind: "code", experimentId: "e1", branch: "b", view: "files" },
    { kind: "code", experimentId: "e1", branch: "b", view: "changes" },
  ];
  for (const pane of desktopOnly) assert.deepEqual(mobilePaneView(pane), { kind: "desktopOnly" }, JSON.stringify(pane));
});

test("no pane, or a side chat pane, shows the chat", () => {
  assert.deepEqual(mobilePaneView(undefined), { kind: "chat" });
  assert.deepEqual(mobilePaneView({ kind: "side", sessionId: "s2" }), { kind: "chat" });
});

const promptPart = (id, kind, resolved) => ({ id, type: "prompt", prompt: { kind, resolved } });
const message = (id, parts) => ({ id, role: "assistant", parts, createdAt: 0 });

test("pending prompts count unresolved permission, plan and question cards per session", () => {
  const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "unloaded" }];
  const messages = {
    a: [
      message("m1", [{ id: "t", type: "text", text: "hi" }, promptPart("p1", "permission", false)]),
      message("m2", [promptPart("p2", "plan", false), promptPart("p3", "question", true)]),
    ],
    b: [message("m3", [promptPart("p4", "question", false)])],
    c: [message("m4", [promptPart("p5", "permission", true)])],
    gone: [message("m5", [promptPart("p6", "permission", false)])],
  };
  assert.deepEqual(pendingPrompts(sessions, messages), { total: 3, bySession: { a: 2, b: 1 } });
});

test("answering a prompt lowers the count", () => {
  const before = { a: [message("m", [promptPart("p", "permission", false)])] };
  const after = { a: [message("m", [promptPart("p", "permission", true)])] };
  assert.equal(pendingPrompts([{ id: "a" }], before).total, 1);
  assert.deepEqual(pendingPrompts([{ id: "a" }], after), { total: 0, bySession: {} });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { approveOnComputer, capabilities, hiddenComposerCommands } from "../src/capabilities.ts";

const local = { kind: "local", version: "1.0.0" };
const tunnel = { kind: "local", version: "1.0.0", tunnelAccess: true };
const remote = {
  kind: "ssh",
  version: "1.0.0",
  dashboardProtocol: 1,
  session: { id: "s1" },
};

test("local access keeps every capability", () => {
  const caps = capabilities(local);
  assert.ok(Object.keys(caps).length > 0);
  for (const [name, allowed] of Object.entries(caps)) assert.equal(allowed, true, name);
});

test("an explicit tunnelAccess false is local access", () => {
  assert.deepEqual(capabilities({ ...local, tunnelAccess: false }), capabilities(local));
});

test("Remote keeps every capability Tunnel access would take away", () => {
  assert.deepEqual(capabilities(remote), capabilities(local));
});

test("Tunnel access keeps browsing, chatting, new sessions and run cancel", () => {
  const caps = capabilities(tunnel);
  assert.equal(caps.chat, true);
  assert.equal(caps.newSession, true);
  assert.equal(caps.cancelRun, true);
  assert.equal(caps.permissionMode, true);
});

test("Tunnel access hides what the allowlist refuses", () => {
  const caps = capabilities(tunnel);
  for (const denied of [
    "terminal",
    "shell",
    "codeFiles",
    "editArtifacts",
    "settings",
    "projectCreate",
    "projectDelete",
    "updates",
    "harnessSetup",
    "overleaf",
    "saveUiState",
    "editSession",
    "editQueue",
    "compact",
    "fork",
    "sideChat",
    "importChats",
    "archiveExperiment",
    "remoteHosts",
    "tunnelSettings",
  ]) {
    assert.equal(caps[denied], false, denied);
  }
});

test("Tunnel access drops the composer commands whose actions it refuses", () => {
  assert.deepEqual(hiddenComposerCommands(capabilities(tunnel)).sort(), ["compact", "goal", "resume", "side"]);
  assert.deepEqual(hiddenComposerCommands(capabilities(local)), []);
});

test("over Tunnel access an end-turn Claude approval is left to the computer", () => {
  const endTurn = { kind: "permission", resolved: false };
  const live = { kind: "permission", resolved: false, nativeId: "perm_1" };
  const tunnelCaps = capabilities(tunnel);
  // Claude only grants it by resuming under bypassPermissions.
  assert.equal(approveOnComputer(tunnelCaps, "claude-code", "acceptEdits", endTurn), true);
  assert.equal(approveOnComputer(tunnelCaps, "claude-code", null, endTurn), true);
  // Already bypassing: nothing loosens.
  assert.equal(approveOnComputer(tunnelCaps, "claude-code", "bypassPermissions", endTurn), false);
  // A live bridged approval grants just that call.
  assert.equal(approveOnComputer(tunnelCaps, "claude-code", "manual", live), false);
  // Other harnesses reply inline.
  assert.equal(approveOnComputer(tunnelCaps, "codex", "ask", endTurn), false);
  assert.equal(
    approveOnComputer(tunnelCaps, "claude-code", "manual", { kind: "question", resolved: false }),
    false,
  );
  // Locally every approval stays here.
  assert.equal(approveOnComputer(capabilities(local), "claude-code", "manual", endTurn), false);
});

test("over Tunnel access a plan approval leaves the resume mode to the server", () => {
  assert.equal(capabilities(tunnel).planResumeModes, false);
  assert.equal(capabilities(local).planResumeModes, true);
});

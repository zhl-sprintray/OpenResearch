import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveOnComputer,
  capabilities,
  codeTabView,
  fileReadable,
  hiddenComposerCommands,
  permissionPicker,
} from "../src/capabilities.ts";

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

const choice = (id) => ({ id, label: id });
const claudeModes = ["manual", "acceptEdits", "plan", "auto", "bypassPermissions"].map(choice);
const codexModes = ["ask", "approve-for-me", "full-access"].map(choice);
const ids = (picker) => picker.choices.map((item) => item.id);

test("over Tunnel access the mode picker lists nothing looser than the ceiling", () => {
  const picker = permissionPicker(capabilities(tunnel), claudeModes, "acceptEdits", "auto");
  assert.deepEqual(ids(picker), ["manual", "acceptEdits", "plan"]);
  assert.equal(picker.defaultId, "acceptEdits");
  assert.deepEqual(ids(permissionPicker(capabilities(tunnel), codexModes, "approve-for-me", "approve-for-me")), [
    "ask",
    "approve-for-me",
  ]);
});

test("over Tunnel access with no ceiling the picker stops at the strictest asking mode", () => {
  const claude = permissionPicker(capabilities(tunnel), claudeModes, null, "auto");
  assert.deepEqual(ids(claude), ["manual", "plan"]);
  assert.equal(claude.defaultId, "manual");
  assert.deepEqual(ids(permissionPicker(capabilities(tunnel), codexModes, null, "approve-for-me")), ["ask"]);
});

test("locally the mode picker lists every mode with the harness default", () => {
  const picker = permissionPicker(capabilities(local), claudeModes, "manual", "auto");
  assert.deepEqual(ids(picker), ids({ choices: claudeModes }));
  assert.equal(picker.defaultId, "auto");
});

test("over Tunnel access only artifact files open; repo and absolute files are desktop-only", () => {
  const tunnelCaps = capabilities(tunnel);
  assert.equal(fileReadable(tunnelCaps, { source: "artifacts" }), true);
  for (const source of [undefined, "repo", "abs"]) {
    assert.equal(fileReadable(tunnelCaps, { source }), false, String(source));
    assert.equal(fileReadable(capabilities(local), { source }), true, String(source));
  }
});

test("over Tunnel access an experiment's code shows its diff, never the file browser", () => {
  assert.equal(codeTabView(capabilities(tunnel), "files"), "changes");
  assert.equal(codeTabView(capabilities(tunnel), "changes"), "changes");
  assert.equal(codeTabView(capabilities(local), "files"), "files");
});

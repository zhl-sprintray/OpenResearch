import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Messages render as `key(params)` so each case names the string it shows.
function load() {
  const source = readFileSync(new URL("../src/composerPlaceholder.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const m = new Proxy({}, { get: (_, name) => (params) => params ? `${String(name)}(${Object.values(params).join(",")})` : String(name) });
  const exports = {};
  new Function("require", "exports", code)((id) => {
    if (id === "./paraglide/messages.js") return { m };
    throw new Error(`Unexpected dependency: ${id}`);
  }, exports);
  return exports.composerPlaceholder;
}

const composerPlaceholder = load();
const base = { answeringQuestion: false, steer: null, harness: "Claude Code", harnessReady: true, shell: true };

test("the shell hint appears only where a leading ! runs a shell command", () => {
  assert.equal(composerPlaceholder(base), "chat_message_harness(Claude Code)");
  assert.equal(composerPlaceholder({ ...base, shell: false }), "chat_message_harness_no_shell(Claude Code)");
  assert.equal(composerPlaceholder({ ...base, harness: null }), "chat_ask_agent_placeholder");
  assert.equal(composerPlaceholder({ ...base, harness: null, shell: false }), "chat_ask_agent_placeholder_no_shell");
});

test("questions, steering and unavailable harnesses keep their own prompts", () => {
  assert.equal(composerPlaceholder({ ...base, answeringQuestion: true, shell: false }), "chat_type_custom_answer");
  assert.equal(composerPlaceholder({ ...base, steer: { harness: "Codex", shortcut: "⌘↵" } }), "chat_steer_placeholder(Codex,⌘↵)");
  assert.equal(composerPlaceholder({ ...base, harnessReady: false, shell: false }), "chat_harness_unavailable(Claude Code)");
});

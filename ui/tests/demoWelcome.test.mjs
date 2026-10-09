import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import ts from "typescript";

const require = createRequire(import.meta.url);
const messages = { m: new Proxy({}, { get: (_, name) => () => String(name) }) };

function load(file, mocks, globals = {}) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  new Function("require", "exports", ...Object.keys(globals), code)(
    (name) => mocks[name] ?? require(name), exports, ...Object.values(globals),
  );
  return exports;
}

function nodes(tree) {
  if (!React.isValidElement(tree)) return [];
  return [tree, ...React.Children.toArray(tree.props.children).flatMap(nodes)];
}

const { DemoWelcomeModal } = load("components/Tour.tsx", {
  react: {
    ...React,
    useCallback: (fn) => fn,
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useState: (initial) => [initial, () => {}],
  },
  "react-dom": { createPortal: (tree) => tree },
  "../paraglide/messages.js": messages,
  "lucide-react": { X: "Icon" },
  "./Wordmark": { BrandMark: "BrandMark" },
  "./ui": { Button: "button", IconButton: "button" },
}, { document: { body: {} } });

const createButton = (tree) =>
  nodes(tree).find((node) => node.type === "button" && node.props.children === "tour_create_a_new_project");

test("the demo welcome offers to create a project where projects can be created", () => {
  const tree = DemoWelcomeModal({ onClose: async () => {}, onCreateProject: async () => {} });
  assert.ok(createButton(tree));
});

test("the demo welcome leaves out project creation where it is unavailable (Tunnel access)", () => {
  const tree = DemoWelcomeModal({ onClose: async () => {} });
  assert.equal(createButton(tree), undefined);
  assert.ok(nodes(tree).some((node) => node.props.children === "tour_run_demo_experiment"));
});

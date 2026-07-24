import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const actionPath = fileURLToPath(new URL("../action.yml", import.meta.url));
const action = await readFile(actionPath, "utf8");

const stepBlock = (name) => {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `    - name: ${escapedName}\\n(?<body>[\\s\\S]*?)(?=\\n    - name:|$)`,
    "u",
  ).exec(action);
  assert.ok(match?.groups?.body, `Missing action step: ${name}`);
  return match.groups.body;
};

test("exposes github.token only to the reconciliation planner", () => {
  assert.equal(
    action.match(/\$\{\{ github\.token \}\}/gu)?.length,
    1,
  );

  const planner = stepBlock("Plan reconciliation");
  assert.match(planner, /RECONCILE_GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(planner, /working-directory: \$\{\{ github\.action_path \}\}/u);
  assert.match(planner, /BASH_ENV: ""/u);
  assert.match(planner, /NODE_OPTIONS: ""/u);
  assert.doesNotMatch(planner, /run-sst|remove-reconciled|npx sst/u);
});

test("keeps tokens out of both SST-bearing reconciliation steps", () => {
  for (const name of [
    "Discover reconciliation candidates",
    "Remove reconciled stages",
  ]) {
    const step = stepBlock(name);
    assert.match(step, /GH_TOKEN: ""/u);
    assert.match(step, /GITHUB_TOKEN: ""/u);
    assert.match(step, /RECONCILE_GITHUB_TOKEN: ""/u);
  }
});

test("gates token-bearing steps with trusted inputs and event context", () => {
  for (const name of [
    "Plan reconciliation",
    "Remove reconciled stages",
  ]) {
    const step = stepBlock(name);
    assert.match(step, /inputs\.operation == 'reconcile'/u);
    assert.match(step, /github\.event_name == 'schedule'/u);
    assert.match(step, /github\.event_name == 'workflow_dispatch'/u);
    assert.doesNotMatch(step, /steps\.[^.]+\.outputs\.operation/u);
  }
});

"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { implementationRevision } = require("../context/index.cjs");

test("analysis checks the downloaded implementation before dependencies, Docker, or model work", () => {
  const root = resolve(__dirname, "..");
  const action = readFileSync(resolve(root, "action.yml"), "utf8");
  const steps = action.slice(action.indexOf("  steps:\n"));
  const preflight = steps.split("\n    - name:")[1];
  assert.match(preflight, /actions\/github-script@/);
  assert.match(preflight, /AI_REVIEW_ACTION_PATH: \$\{\{ github.action_path \}\}/);
  assert.match(preflight, /REVIEW_CONTEXT: \$\{\{ inputs.review-context \}\}/);
  const script = preflight.split("        script: |\n")[1]
    .split("\n").map(line => line.startsWith("          ") ? line.slice(10) : line).join("\n");
  assert.ok(!script.includes("${{"));
  const run = reviewContext => new Function("require", "process", script)(require, {
    env: { AI_REVIEW_ACTION_PATH: root, REVIEW_CONTEXT: reviewContext },
  });
  assert.doesNotThrow(() => run(JSON.stringify({ source_digest: implementationRevision(),
    pr: { title: "Untrusted quotes: '\"` ${process.exit()}" },
  })));
  assert.doesNotThrow(() => run("{}"));
  assert.throws(() => run(JSON.stringify({ source_digest: "0".repeat(64) })), /implementation changed/);
  assert.throws(() => run(JSON.stringify({ source_digest: "main" })), /source_digest/);
});

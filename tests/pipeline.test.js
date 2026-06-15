import assert from "node:assert/strict";
import test from "node:test";

import { defineConfig } from "../dist/index.js";
import { hygieneTask, readAsyncPipelineDeclaration } from "../dist/pipeline.js";

test("PROMISE: hygieneTask returns exactly one hidden hygiene task", () => {
  const config = defineConfig({
    mode: "auto",
    targets: {
      packages: [{ path: "packages/pipeline" }]
    }
  });

  const tasks = { hygiene: hygieneTask(config) };

  assert.deepEqual(Object.keys(tasks), ["hygiene"]);
  assert.equal(tasks.hygiene.run.command, "async-hygiene check");
  assert.deepEqual(readAsyncPipelineDeclaration(tasks.hygiene), { kind: "task", version: 1 });
  assert.deepEqual(readAsyncPipelineDeclaration(tasks.hygiene.run), { kind: "shell", version: 1 });
  assert.equal(JSON.stringify(tasks).includes("actionlint"), false);
  assert.equal(JSON.stringify(tasks).includes("knip"), false);
  assert.equal(JSON.stringify(tasks).includes("depcruise"), false);
  assert.equal(JSON.stringify(tasks).includes("publint"), false);
});


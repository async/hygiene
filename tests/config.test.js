import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { defineConfig, detectMode, loadConfig, runHygiene, selectedGateIds } from "../dist/index.js";

test("loads typed hygiene.config.ts directly", async () => {
  const dir = await tempDir("hygiene-config-");
  await writeFile(join(dir, "hygiene.config.ts"), `
    import { defineConfig } from "../../../dist/index.js";
    export default defineConfig({
      mode: "package",
      gates: [],
      targets: { packages: [{ path: "." }] }
    });
  `);
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@demo/pkg", version: "1.0.0", type: "module" }));

  const config = await loadConfig({ cwd: dir });

  assert.equal(config.mode, "package");
  assert.deepEqual(config.gates, []);
});

test("rejects unknown config fields", () => {
  assert.throws(() => defineConfig({ toolz: true }), /unknown field "toolz"/);
  assert.throws(() => defineConfig({ targets: { packages: [{ path: ".", extra: true }] } }), /unknown field "extra"/);
});

test("detects app, package, and mixed modes", async () => {
  const app = await tempDir("hygiene-app-");
  await writeFile(join(app, "package.json"), JSON.stringify({ private: true, type: "module" }));
  assert.equal(await detectMode(defineConfig({ mode: "auto" }), { cwd: app }), "app");

  const pkg = await tempDir("hygiene-pkg-");
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@demo/pkg", version: "1.0.0", type: "module" }));
  assert.equal(await detectMode(defineConfig({ mode: "auto" }), { cwd: pkg }), "package");

  assert.equal(await detectMode(defineConfig({ mode: "auto", targets: { packages: [{ path: "packages/lib" }] } }), { cwd: app }), "mixed");
});

test("selects hidden generic gate ids by mode", () => {
  assert.deepEqual(selectedGateIds(defineConfig({ mode: "app" }), "app"), ["workflow", "dependencies", "unused"]);
  assert.deepEqual(selectedGateIds(defineConfig({ mode: "package" }), "package"), ["workflow", "dependencies", "unused", "package"]);
  assert.deepEqual(selectedGateIds(defineConfig({ gates: ["package"] }), "mixed"), ["package"]);
});

test("runHygiene returns one combined report", async () => {
  const dir = await tempDir("hygiene-report-");
  await writeFile(join(dir, "package.json"), JSON.stringify({ private: true, type: "module" }));

  const report = await runHygiene({ cwd: dir, config: { mode: "app", gates: [] } });

  assert.equal(report.ok, true);
  assert.equal(report.mode, "app");
  assert.deepEqual(report.gates, []);
  assert.deepEqual(report.failures, []);
});

async function tempDir(prefix) {
  const root = join(process.cwd(), ".async", "tests");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}

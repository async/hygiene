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
  assert.throws(() => defineConfig({ mode: "library" }), /Unknown hygiene mode "library"/);
  assert.throws(() => defineConfig({ targets: { packages: [{ path: "../outside" }] } }), /path must stay inside the repository/);
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

test("fixture projects report app, package, and mixed modes", async () => {
  const app = await tempDir("hygiene-fixture-app-");
  await writeFile(join(app, "package.json"), JSON.stringify({ private: true, type: "module" }));
  assert.equal((await runHygiene({ cwd: app, config: { mode: "app", gates: [] } })).mode, "app");

  const pkg = await tempDir("hygiene-fixture-package-");
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@demo/pkg", version: "1.0.0", type: "module" }));
  assert.equal((await runHygiene({ cwd: pkg, config: { mode: "package", gates: [], targets: { packages: [{ path: "." }] } } })).mode, "package");

  const mixed = await tempDir("hygiene-fixture-mixed-");
  await mkdir(join(mixed, "packages", "lib"), { recursive: true });
  await writeFile(join(mixed, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await writeFile(join(mixed, "packages", "lib", "package.json"), JSON.stringify({ name: "@demo/lib", version: "1.0.0", type: "module" }));
  assert.equal((await runHygiene({ cwd: mixed, config: { mode: "mixed", gates: [], targets: { packages: [{ path: "packages/lib" }] } } })).mode, "mixed");
});

test("mixed mode requires explicit targets", async () => {
  const dir = await tempDir("hygiene-mixed-targets-");
  await writeFile(join(dir, "package.json"), JSON.stringify({ private: true, type: "module" }));

  await assert.rejects(
    runHygiene({ cwd: dir, config: { mode: "mixed", gates: [] } }),
    /mixed hygiene mode requires explicit app or package targets/
  );
});

async function tempDir(prefix) {
  const root = join(process.cwd(), ".async", "tests");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}

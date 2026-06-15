import { checkPackage, createPackageFromTarballData } from "@arethetypeswrong/core";
import { actionlint } from "github-actionlint";
import { publint } from "publint";
import { formatMessage } from "publint/utils";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export type HygieneMode = "auto" | "app" | "package" | "mixed";
export type ResolvedHygieneMode = Exclude<HygieneMode, "auto">;
export type HygieneGateId = "workflow" | "dependencies" | "unused" | "package";
export type PackageManager = "npm" | "pnpm" | "yarn";

export interface HygieneTarget {
  path: string;
  name?: string;
}

export interface HygieneTargets {
  apps?: HygieneTarget[];
  packages?: HygieneTarget[];
}

export interface DependencyBoundaryRule {
  name?: string;
  severity?: "error" | "warn" | "info" | "ignore";
  comment?: string;
  from?: Record<string, unknown>;
  to?: Record<string, unknown>;
  module?: Record<string, unknown>;
  scope?: "module" | "folder";
}

export interface DependencyBoundaryConfig {
  sources?: string[];
  rules?: DependencyBoundaryRule[];
  options?: Record<string, unknown>;
}

export interface UnusedSurfaceConfig {
  config?: Record<string, unknown>;
}

export interface PackageHygieneConfig {
  strict?: boolean;
  typeProfile?: "strict" | "node16" | "esm-only" | "node16-esm" | "node10";
  typeFormat?: "ascii" | "table" | "table-flipped" | "json";
}

export interface HygieneTaskConfig {
  dependsOn?: string[];
  inputs?: string[];
  cache?: boolean;
  description?: string;
}

export interface HygieneConfig {
  mode?: HygieneMode;
  targets?: HygieneTargets;
  gates?: HygieneGateId[];
  workflows?: string[];
  packageManager?: PackageManager;
  dependencies?: DependencyBoundaryConfig;
  unused?: UnusedSurfaceConfig;
  package?: PackageHygieneConfig;
  task?: HygieneTaskConfig;
}

export interface LoadConfigOptions {
  cwd?: string;
  configPath?: string;
}

export interface DetectModeOptions {
  cwd?: string;
  override?: Exclude<HygieneMode, "auto">;
}

export interface RunHygieneOptions extends LoadConfigOptions {
  config?: HygieneConfig;
  mode?: Exclude<HygieneMode, "auto">;
  format?: "text" | "json";
}

export interface RunGateOptions extends LoadConfigOptions {
  config?: HygieneConfig;
  mode?: Exclude<HygieneMode, "auto">;
}

export interface HygieneGateResult {
  id: HygieneGateId;
  ok: boolean;
  title: string;
  skipped?: boolean;
  stdout?: string;
  stderr?: string;
  messages: string[];
}

export interface HygieneReport {
  ok: boolean;
  mode: ResolvedHygieneMode;
  cwd: string;
  gates: HygieneGateResult[];
  failures: string[];
}

const defaultConfigFile = "hygiene.config.ts";
const asyncDir = ".async/hygiene";
const configFields = new Set(["mode", "targets", "gates", "workflows", "packageManager", "dependencies", "unused", "package", "task"]);
const targetsFields = new Set(["apps", "packages"]);
const targetFields = new Set(["path", "name"]);
const dependenciesFields = new Set(["sources", "rules", "options"]);
const unusedFields = new Set(["config"]);
const packageFields = new Set(["strict", "typeProfile", "typeFormat"]);
const taskFields = new Set(["dependsOn", "inputs", "cache", "description"]);
const modes = new Set<HygieneMode>(["auto", "app", "package", "mixed"]);
const resolvedModes = new Set<ResolvedHygieneMode>(["app", "package", "mixed"]);
const gates = new Set<HygieneGateId>(["workflow", "dependencies", "unused", "package"]);

export function defineConfig(config: HygieneConfig): HygieneConfig {
  validateConfig(config);
  return config;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<HygieneConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(cwd, options.configPath ?? defaultConfigFile);
  let exists = true;
  try {
    await stat(configPath);
  } catch {
    exists = false;
  }
  if (!exists) return defineConfig({});

  const moduleUrl = pathToFileURL(configPath);
  moduleUrl.searchParams.set("mtime", String((await stat(configPath)).mtimeMs));
  const loaded = await import(moduleUrl.href) as { default?: unknown };
  if (!isPlainObject(loaded.default)) {
    throw new HygieneConfigError(`${relativePath(cwd, configPath)} must export a default config object.`);
  }
  return defineConfig(loaded.default);
}

export async function detectMode(config: HygieneConfig, options: DetectModeOptions = {}): Promise<ResolvedHygieneMode> {
  validateConfig(config);
  if (options.override) return options.override;
  const configured = config.mode ?? "auto";
  if (configured !== "auto") return configured;
  if (hasTargets(config.targets)) return "mixed";
  if (await isRootPublishable(resolve(options.cwd ?? process.cwd()))) return "package";
  return "app";
}

export function selectedGateIds(config: HygieneConfig, mode: ResolvedHygieneMode): HygieneGateId[] {
  validateConfig(config);
  if (config.gates) return [...config.gates];
  const repoGates: HygieneGateId[] = ["workflow", "dependencies", "unused"];
  return mode === "app" ? repoGates : [...repoGates, "package"];
}

export async function runHygiene(options: RunHygieneOptions = {}): Promise<HygieneReport> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const config = options.config ? defineConfig(options.config) : await loadConfig({ cwd, configPath: options.configPath });
  const mode = await detectMode(config, { cwd, override: options.mode });
  validateResolvedConfig(config, mode);
  const results: HygieneGateResult[] = [];
  for (const gateId of selectedGateIds(config, mode)) {
    results.push(await runGate(gateId, { cwd, config, mode }));
  }
  const failures = results.flatMap((result) => result.ok ? [] : result.messages.length ? result.messages.map((message) => `${result.id}: ${message}`) : [`${result.id}: failed`]);
  return { ok: failures.length === 0, mode, cwd, gates: results, failures };
}

export async function runGate(gateId: HygieneGateId, options: RunGateOptions = {}): Promise<HygieneGateResult> {
  if (!gates.has(gateId)) throw new HygieneConfigError(`Unknown hygiene gate "${gateId}".`);
  const cwd = resolve(options.cwd ?? process.cwd());
  const config = options.config ? defineConfig(options.config) : await loadConfig({ cwd, configPath: options.configPath });
  const mode = await detectMode(config, { cwd, override: options.mode });
  validateResolvedConfig(config, mode);
  switch (gateId) {
    case "workflow":
      return runWorkflowGate(cwd, config);
    case "dependencies":
      return runDependenciesGate(cwd, config);
    case "unused":
      return runUnusedGate(cwd, config);
    case "package":
      return runPackageGate(cwd, config, mode);
  }
}

export function hygieneTargets(config: HygieneConfig, mode: ResolvedHygieneMode): { apps: HygieneTarget[]; packages: HygieneTarget[] } {
  validateConfig(config);
  const apps = normalizeTargets(config.targets?.apps);
  const packages = normalizeTargets(config.targets?.packages);
  if (mode === "package" && packages.length === 0) packages.push({ path: "." });
  if (mode === "app" && apps.length === 0) apps.push({ path: "." });
  return { apps, packages };
}

export class HygieneConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HygieneConfigError";
  }
}

async function runWorkflowGate(cwd: string, config: HygieneConfig): Promise<HygieneGateResult> {
  const patterns = config.workflows ?? [".github/workflows/*.yml", ".github/workflows/*.yaml"];
  const files = await expandPatterns(cwd, patterns);
  if (files.length === 0) {
    return pass("workflow", "Workflow hygiene", ["No workflow files matched."]);
  }
  const result = await actionlint({
    args: ["-shellcheck=", "-pyflakes=", ...files],
    spawnOptions: { cwd }
  });
  return commandGateResult("workflow", "Workflow hygiene", {
    code: result.code,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8")
  });
}

async function runDependenciesGate(cwd: string, config: HygieneConfig): Promise<HygieneGateResult> {
  const dir = await ensureAsyncDir(cwd);
  const configPath = join(dir, "dependencies.cjs");
  const boundaryConfig = {
    forbidden: [
      noCircularRule(),
      noNonPackageJsonRule(),
      notToUnresolvableRule(),
      ...(config.dependencies?.rules ?? [])
    ],
    options: {
      combinedDependencies: true,
      preserveSymlinks: true,
      exclude: { path: "(^|/)(\\.async|node_modules|dist|build)/" },
      ...(config.dependencies?.options ?? {})
    }
  };
  await writeFile(configPath, `module.exports = ${JSON.stringify(boundaryConfig, null, 2)};\n`);
  const sources = config.dependencies?.sources ?? ["src", "tests"];
  const result = await runNodeScript(dependencyCruiserBin(), ["--config", configPath, "--output-type", "err", ...sources], { cwd });
  return commandGateResult("dependencies", "Dependency hygiene", result);
}

async function runUnusedGate(cwd: string, config: HygieneConfig): Promise<HygieneGateResult> {
  const dir = await ensureAsyncDir(cwd);
  const configPath = join(dir, "unused.json");
  const unusedConfig = config.unused?.config ?? {};
  await writeFile(configPath, `${JSON.stringify(unusedConfig, null, 2)}\n`);
  const result = await runNodeScript(knipBin(), ["--config", configPath, "--no-progress"], { cwd });
  return commandGateResult("unused", "Unused surface hygiene", result);
}

async function runPackageGate(cwd: string, config: HygieneConfig, mode: ResolvedHygieneMode): Promise<HygieneGateResult> {
  const targets = hygieneTargets(config, mode).packages;
  if (targets.length === 0) return pass("package", "Package hygiene", ["No package targets configured."]);

  const messages: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  for (const target of targets) {
    const targetDir = resolveTarget(cwd, target.path);
    const label = target.name ?? target.path;
    const publishResult = await publint({
      pkgDir: targetDir,
      strict: config.package?.strict ?? true,
      pack: config.packageManager ?? "npm"
    });
    for (const message of publishResult.messages) {
      const formatted = formatMessage(message, publishResult.pkg, { color: false }) ?? `${message.code} at ${message.path.join(".")}`;
      stdout.push(`${label}: ${formatted}`);
      if (message.type === "error") messages.push(`${label}: ${formatted}`);
    }

    const typeResult = await runNodeScript(attwBin(), [
      targetDir,
      "--pack",
      "--profile",
      config.package?.typeProfile ?? "esm-only",
      "--format",
      config.package?.typeFormat ?? "ascii",
      "--no-emoji"
    ], { cwd });
    if (typeResult.stdout) stdout.push(typeResult.stdout.trimEnd());
    if (typeResult.stderr) stderr.push(typeResult.stderr.trimEnd());
    if (typeResult.code !== 0) messages.push(`${label}: package type resolution failed.`);
  }
  return {
    id: "package",
    title: "Package hygiene",
    ok: messages.length === 0,
    stdout: stdout.filter(Boolean).join("\n"),
    stderr: stderr.filter(Boolean).join("\n"),
    messages
  };
}

function validateConfig(config: HygieneConfig): void {
  if (!isPlainObject(config)) throw new HygieneConfigError("Hygiene config must be an object.");
  rejectUnknown(configFields, config, "hygiene config");
  const mode = (config as Record<string, unknown>).mode;
  if (mode !== undefined && !isHygieneMode(mode)) throw new HygieneConfigError(`Unknown hygiene mode "${String(mode)}".`);
  if (config.gates !== undefined) {
    if (!Array.isArray(config.gates)) throw new HygieneConfigError("hygiene config gates must be an array.");
    for (const gateId of config.gates) {
      if (!gates.has(gateId)) throw new HygieneConfigError(`Unknown hygiene gate "${String(gateId)}".`);
    }
  }
  if (config.targets !== undefined) {
    if (!isPlainObject(config.targets)) throw new HygieneConfigError("hygiene config targets must be an object.");
    rejectUnknown(targetsFields, config.targets, "hygiene config targets");
    const targets = config.targets as Record<string, unknown>;
    validateTargetList(targets.apps, "targets.apps");
    validateTargetList(targets.packages, "targets.packages");
  }
  if (config.dependencies !== undefined) {
    if (!isPlainObject(config.dependencies)) throw new HygieneConfigError("hygiene config dependencies must be an object.");
    rejectUnknown(dependenciesFields, config.dependencies, "hygiene config dependencies");
  }
  if (config.unused !== undefined) {
    if (!isPlainObject(config.unused)) throw new HygieneConfigError("hygiene config unused must be an object.");
    rejectUnknown(unusedFields, config.unused, "hygiene config unused");
  }
  if (config.package !== undefined) {
    if (!isPlainObject(config.package)) throw new HygieneConfigError("hygiene config package must be an object.");
    rejectUnknown(packageFields, config.package, "hygiene config package");
  }
  if (config.task !== undefined) {
    if (!isPlainObject(config.task)) throw new HygieneConfigError("hygiene config task must be an object.");
    rejectUnknown(taskFields, config.task, "hygiene config task");
  }
}

function validateResolvedConfig(config: HygieneConfig, mode: ResolvedHygieneMode): void {
  if (!resolvedModes.has(mode)) throw new HygieneConfigError(`Unknown resolved hygiene mode "${String(mode)}".`);
  if (mode === "mixed" && !hasTargets(config.targets)) {
    throw new HygieneConfigError("mixed hygiene mode requires explicit app or package targets.");
  }
}

function validateTargetList(targets: unknown, where: string): void {
  if (targets === undefined) return;
  if (!Array.isArray(targets)) throw new HygieneConfigError(`${where} must be an array.`);
  for (const target of targets) {
    if (!isPlainObject(target)) throw new HygieneConfigError(`${where} entries must be objects.`);
    rejectUnknown(targetFields, target, `${where} entry`);
    if (typeof target.path !== "string" || target.path.length === 0) throw new HygieneConfigError(`${where} entries require a non-empty path.`);
    if (isAbsolute(target.path) || target.path.split(/[\\/]+/).includes("..")) throw new HygieneConfigError(`${where} path must stay inside the repository.`);
    if (target.name !== undefined && (typeof target.name !== "string" || target.name.length === 0)) throw new HygieneConfigError(`${where} name must be a non-empty string.`);
  }
}

function isHygieneMode(value: unknown): value is HygieneMode {
  return typeof value === "string" && modes.has(value as HygieneMode);
}

function rejectUnknown(allowed: Set<string>, value: object, where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new HygieneConfigError(`${where} has unknown field "${key}".`);
  }
}

async function isRootPublishable(cwd: string): Promise<boolean> {
  const packagePath = join(cwd, "package.json");
  try {
    const manifest = JSON.parse(await readFile(packagePath, "utf8")) as { private?: boolean; name?: string; version?: string };
    return manifest.private !== true && typeof manifest.name === "string" && typeof manifest.version === "string";
  } catch {
    return false;
  }
}

function hasTargets(targets: HygieneTargets | undefined): boolean {
  return Boolean(targets && ((targets.apps?.length ?? 0) > 0 || (targets.packages?.length ?? 0) > 0));
}

function normalizeTargets(targets: HygieneTarget[] | undefined): HygieneTarget[] {
  return targets ? targets.map((target) => ({ ...target })) : [];
}

function resolveTarget(cwd: string, targetPath: string): string {
  const absolute = resolve(cwd, targetPath);
  if (absolute !== cwd && !absolute.startsWith(`${cwd}${sep}`)) throw new HygieneConfigError(`Target path ${targetPath} must stay inside the repository.`);
  return absolute;
}

async function ensureAsyncDir(cwd: string): Promise<string> {
  const dir = join(cwd, asyncDir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function pass(id: HygieneGateId, title: string, messages: string[] = []): HygieneGateResult {
  return { id, title, ok: true, messages };
}

function commandGateResult(id: HygieneGateId, title: string, result: CommandResult): HygieneGateResult {
  const stdout = result.stdout.trimEnd();
  const stderr = result.stderr.trimEnd();
  return {
    id,
    title,
    ok: result.code === 0,
    stdout,
    stderr,
    messages: result.code === 0 ? [] : [stderr || stdout || `Exited with code ${result.code}.`]
  };
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runNodeScript(script: string, args: string[], options: { cwd: string }): Promise<CommandResult> {
  return runCommand(process.execPath, [script, ...args], options);
}

async function runCommand(command: string, args: string[], options: { cwd: string }): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolvePromise({ code: code ?? (signal ? 1 : 0), stdout, stderr });
    });
  });
}

async function expandPatterns(cwd: string, patterns: string[]): Promise<string[]> {
  const files = await walkFiles(cwd);
  const matches = new Set<string>();
  for (const pattern of patterns) {
    const matcher = globMatcher(pattern);
    for (const file of files) {
      if (matcher(file)) matches.add(file);
    }
  }
  return [...matches].sort();
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".async" || entry.name === "dist") continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push(relativePath(root, absolute));
      }
    }
  }
  await walk(root);
  return files;
}

function globMatcher(pattern: string): (value: string) => boolean {
  const normalized = pattern.replaceAll("\\", "/");
  let regex = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      regex += ".*";
      index += 1;
    } else if (char === "*") {
      regex += "[^/]*";
    } else {
      regex += escapeRegExp(char ?? "");
    }
  }
  regex += "$";
  const compiled = new RegExp(regex);
  return (value) => compiled.test(value.replaceAll("\\", "/"));
}

function dependencyCruiserBin(): string {
  return join(packageRoot("dependency-cruiser", 3), "bin", "dependency-cruise.mjs");
}

function knipBin(): string {
  return join(packageRoot("knip", 2), "bin", "knip.js");
}

function attwBin(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@arethetypeswrong/cli/package.json")), "dist", "index.js");
}

function packageRoot(specifier: string, levelsFromEntry: number): string {
  let current = dirname(import.meta.resolve(specifier).replace("file://", ""));
  for (let index = 1; index < levelsFromEntry; index += 1) current = dirname(current);
  return current;
}

function noCircularRule(): DependencyBoundaryRule {
  return {
    name: "no-circular",
    severity: "error",
    comment: "This dependency is part of a circular relationship.",
    from: {},
    to: { circular: true }
  };
}

function noNonPackageJsonRule(): DependencyBoundaryRule {
  return {
    name: "no-non-package-json",
    severity: "error",
    comment: "This module depends on an npm package that is not declared in package.json.",
    from: {},
    to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] }
  };
}

function notToUnresolvableRule(): DependencyBoundaryRule {
  return {
    name: "not-to-unresolvable",
    severity: "error",
    comment: "This module depends on a module that cannot be resolved to disk.",
    from: {},
    to: { couldNotResolve: true }
  };
}

async function npmPackTarball(packageDir: string, cwd: string): Promise<string> {
  const outDir = await ensureAsyncDir(cwd);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const result = await runCommand("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", outDir], { cwd: packageDir });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "npm pack failed.");
  const packed = JSON.parse(result.stdout) as Array<{ filename: string }>;
  const filename = packed[0]?.filename;
  if (!filename) throw new Error("npm pack did not report a tarball filename.");
  return join(outDir, filename);
}

export async function checkPackageTypes(packageDir: string, cwd = process.cwd()): Promise<{ ok: boolean; problemCount: number }> {
  const tarball = await npmPackTarball(packageDir, cwd);
  const packed = createPackageFromTarballData(new Uint8Array(await readFile(tarball)));
  const result = await checkPackage(packed);
  return { ok: !("problems" in result) || result.problems.length === 0, problemCount: "problems" in result ? result.problems.length : 0 };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relativePath(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/") || ".";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

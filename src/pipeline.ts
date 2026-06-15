import type { HygieneConfig, HygieneMode } from "./index.js";

export const ASYNC_PIPELINE_DECLARATION = Symbol.for("@async/pipeline.declaration");
export const ASYNC_PIPELINE_DECLARATION_VERSION = 1;

export interface AsyncPipelineDeclarationMetadata {
  kind: string;
  version: number;
}

export interface PortableShellStep {
  kind: "shell";
  command: string;
}

export interface PortableTaskDefinition {
  description: string;
  dependsOn?: string[];
  inputs: string[];
  cache: boolean;
  run: PortableShellStep;
}

export interface HygienePipelineTaskOptions {
  configPath?: string;
  mode?: Exclude<HygieneMode, "auto">;
  dependsOn?: string[];
  description?: string;
  inputs?: string[];
  cache?: boolean;
}

export function hygieneTask(config: HygieneConfig = {}, options: HygienePipelineTaskOptions = {}): PortableTaskDefinition {
  const command = ["async-hygiene", "check"];
  if (options.configPath && options.configPath !== "hygiene.config.ts") command.push("--config", shellWord(options.configPath));
  if (options.mode) command.push("--mode", options.mode);

  return brandAsyncPipelineDeclaration({
    description: options.description ?? config.task?.description ?? "Run repository hygiene behind one hidden gate.",
    ...(options.dependsOn ?? config.task?.dependsOn ? { dependsOn: options.dependsOn ?? config.task?.dependsOn } : {}),
    inputs: options.inputs ?? config.task?.inputs ?? hygieneTaskInputs(config, options.configPath ?? "hygiene.config.ts"),
    cache: options.cache ?? config.task?.cache ?? true,
    run: brandAsyncPipelineDeclaration({ kind: "shell", command: command.join(" ") }, "shell")
  }, "task");
}

export function hygieneTaskInputs(config: HygieneConfig = {}, configPath = "hygiene.config.ts"): string[] {
  const inputs = new Set<string>([
    configPath,
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "yarn.lock"
  ]);
  for (const workflow of config.workflows ?? [".github/workflows/*.yml", ".github/workflows/*.yaml"]) inputs.add(workflow);
  for (const source of config.dependencies?.sources ?? ["src", "tests"]) inputs.add(source);
  for (const target of config.targets?.apps ?? []) inputs.add(`${target.path}/package.json`);
  for (const target of config.targets?.packages ?? []) inputs.add(`${target.path}/package.json`);
  return [...inputs];
}

export function readAsyncPipelineDeclaration(value: unknown): AsyncPipelineDeclarationMetadata | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<symbol, AsyncPipelineDeclarationMetadata>)[ASYNC_PIPELINE_DECLARATION];
}

function brandAsyncPipelineDeclaration<T extends object>(value: T, kind: string): T {
  Object.defineProperty(value, ASYNC_PIPELINE_DECLARATION, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: { kind, version: ASYNC_PIPELINE_DECLARATION_VERSION }
  });
  return value;
}

function shellWord(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

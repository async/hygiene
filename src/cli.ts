#!/usr/bin/env node
import { detectMode, HygieneConfigError, loadConfig, runHygiene, selectedGateIds, type HygieneMode } from "./index.js";

interface CliOptions {
  command?: string;
  cwd?: string;
  configPath?: string;
  mode?: Exclude<HygieneMode, "auto">;
  format: "text" | "json";
}

const args = process.argv.slice(2);
runCli(args).then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  if (error instanceof HygieneConfigError) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

export async function runCli(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (!options.command || options.command === "help" || options.command === "--help" || options.command === "-h") {
    console.log(helpText());
    return 0;
  }
  if (options.command === "list") {
    const config = await loadConfig({ cwd: options.cwd, configPath: options.configPath });
    const mode = await detectMode(config, { cwd: options.cwd, override: options.mode });
    const gates = selectedGateIds(config, mode);
    if (options.format === "json") {
      console.log(JSON.stringify({ mode, gates }, null, 2));
    } else {
      console.log(`mode: ${mode}`);
      console.log("gates:");
      for (const gate of gates) console.log(`- ${gate}`);
    }
    return 0;
  }
  if (options.command === "check") {
    const report = await runHygiene({
      cwd: options.cwd,
      configPath: options.configPath,
      mode: options.mode,
      format: options.format
    });
    if (options.format === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }
    return report.ok ? 0 : 1;
  }
  throw new HygieneConfigError(`Unknown async-hygiene command "${options.command}".`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { command: argv[0], format: "text" };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") {
      options.cwd = requiredValue(argv, ++index, "--cwd");
    } else if (arg === "--config") {
      options.configPath = requiredValue(argv, ++index, "--config");
    } else if (arg === "--mode") {
      const mode = requiredValue(argv, ++index, "--mode");
      if (mode !== "app" && mode !== "package" && mode !== "mixed") throw new HygieneConfigError(`--mode must be app, package, or mixed.`);
      options.mode = mode;
    } else if (arg === "--format") {
      const format = requiredValue(argv, ++index, "--format");
      if (format !== "text" && format !== "json") throw new HygieneConfigError(`--format must be text or json.`);
      options.format = format;
    } else {
      throw new HygieneConfigError(`Unknown option "${arg}".`);
    }
  }
  return options;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new HygieneConfigError(`${flag} requires a value.`);
  return value;
}

function printReport(report: Awaited<ReturnType<typeof runHygiene>>): void {
  console.log(`mode: ${report.mode}`);
  for (const gate of report.gates) {
    console.log(`${gate.ok ? "PASS" : "FAIL"} ${gate.id}`);
    if (gate.stdout) console.log(gate.stdout);
    if (gate.stderr) console.error(gate.stderr);
    for (const message of gate.messages) {
      if (!gate.ok) console.error(message);
    }
  }
  if (!report.ok) {
    console.error("");
    console.error("hygiene failed:");
    for (const failure of report.failures) console.error(`- ${failure}`);
  }
}

function helpText(): string {
  return `Usage:
  async-hygiene list [--config hygiene.config.ts] [--mode app|package|mixed]
  async-hygiene check [--config hygiene.config.ts] [--mode app|package|mixed]

Options:
  --cwd <path>       Run from a repository root other than the current directory.
  --config <path>    Config file path relative to the repository root.
  --format <format>  text or json.
`;
}


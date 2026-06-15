# @async/hygiene

`@async/hygiene` hides repository hygiene tooling behind one package, one config file, one CLI command, and one pipeline task.

Consuming repositories should expose a single `hygiene` gate. The underlying tools are implementation details of this package.

## Install

```sh
pnpm add -D @async/hygiene
```

The package is ESM TypeScript, requires Node `>=24`, and ships the `async-hygiene` binary.

## Config

Create `hygiene.config.ts`:

```ts
import { defineConfig } from "@async/hygiene";

export default defineConfig({
  mode: "auto",
  targets: {
    packages: [{ path: "packages/pipeline" }]
  }
});
```

Modes:

- `app`: repo-level hygiene only.
- `package`: repo-level hygiene plus package publish/type/metadata checks.
- `mixed`: repo-level hygiene once, package checks for explicit package targets.
- `auto`: explicit targets select mixed mode; otherwise a publishable root package selects package mode; private roots fall back to app mode.

## CLI

```sh
async-hygiene list
async-hygiene check
async-hygiene check --mode app
async-hygiene check --mode package
async-hygiene check --mode mixed
```

`check` prints one combined report and exits non-zero when any hygiene gate fails.

## Pipeline

Expose one task:

```ts
import { hygieneTask } from "@async/hygiene/pipeline";
import hygieneConfig from "./hygiene.config.ts";

export default definePipeline({
  // ...
  tasks: {
    hygiene: hygieneTask(hygieneConfig),
    pack: task({
      dependsOn: ["test", "hygiene"],
      run: sh`npm --cache .async/npm-cache pack --dry-run`
    })
  }
});
```

Do not expose tool-specific task ids in the consuming repo.


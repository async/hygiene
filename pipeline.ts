import { definePipeline, env, job, sh, task, trigger } from "@async/pipeline";

const packageInputs = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "hygiene.config.ts",
  "src/**/*.ts",
  "tests/**/*.js",
  "README.md",
  "CHANGELOG.md"
];

const pipelineInputs = [
  "pipeline.ts",
  "package.json",
  ".github/workflows/async-pipeline.yml",
  ".github/async-pipeline.lock.json",
  ".async-pipeline/tasks.lock.json"
];

export default definePipeline({
  name: "hygiene",
  cache: "file:local",
  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    release: trigger.github({ events: ["release"], types: ["published"] }),
    manual: trigger.manual()
  },
  sync: {
    github: {
      nodeVersion: 24,
      cache: true
    },
    tasks: {
      prefix: "pipeline",
      runners: ["package"],
      targets: [{ package: "@async/hygiene" }],
      jobs: ["publish", "release-doctor", "snapshot", "verify"],
      tasks: ["build", "github.check", "hygiene", "pack", "release.doctor", "sync.check", "test"],
      scripts: {
        "github:check": "github check",
        "github:generate": "github generate",
        "publish:github:main": "publish github main --package .",
        "publish:github:release": "publish github release --package .",
        "publish:npm": "publish npm --package .",
        "release:doctor": "release doctor --package .",
        "release:ensure": "release ensure --package .",
        "release-doctor": "run release-doctor",
        snapshot: "run snapshot",
        "sync:check": "sync check",
        "sync:generate": "sync generate",
        verify: "run verify",
        "verify:force": "run verify --force"
      }
    }
  },
  tasks: {
    build: task({
      description: "Build the publishable Hygiene package.",
      inputs: packageInputs,
      outputs: ["dist/**"],
      cache: false,
      run: sh`pnpm run build`
    }),
    test: task({
      description: "Run the Hygiene test suite.",
      dependsOn: ["build"],
      inputs: packageInputs,
      cache: false,
      run: sh`node --test tests/*.test.js`
    }),
    hygiene: task({
      description: "Run the hidden repository hygiene gate.",
      dependsOn: ["build"],
      inputs: packageInputs,
      cache: false,
      run: sh`node dist/cli.js check`
    }),
    "sync.check": task({
      description: "Validate generated package scripts and task locks from pipeline.ts.",
      inputs: pipelineInputs,
      cache: false,
      run: sh`pnpm async-pipeline sync check`
    }),
    "github.check": task({
      description: "Validate generated GitHub Actions workflow and lock state from pipeline.ts.",
      inputs: pipelineInputs,
      cache: false,
      run: sh`pnpm async-pipeline github check`
    }),
    pack: task({
      description: "Verify the public npm package contents without publishing.",
      dependsOn: ["test", "hygiene", "sync.check", "github.check"],
      inputs: [...packageInputs, "dist/**"],
      cache: false,
      run: sh`pnpm run pack:check`
    }),
    snapshot: task({
      description: "Publish a main-branch snapshot package to GitHub Packages.",
      dependsOn: ["pack"],
      inputs: [...packageInputs, "dist/**"],
      cache: false,
      run: sh`pnpm async-pipeline publish github main --package .`
    }),
    "release.ensure": task({
      description: "Create or verify the release tag and GitHub Release before package publishing.",
      dependsOn: ["pack"],
      inputs: [...packageInputs, "dist/**"],
      cache: false,
      run: sh`pnpm async-pipeline release ensure --package .`
    }),
    "publish.github": task({
      description: "Publish the stable GitHub Packages mirror before npm publishing.",
      dependsOn: ["release.ensure"],
      inputs: [...packageInputs, "dist/**"],
      cache: false,
      run: sh`pnpm async-pipeline publish github release --package .`
    }),
    publish: task({
      description: "Publish the verified release to npm, then run release doctor.",
      dependsOn: ["publish.github"],
      inputs: [...packageInputs, "dist/**"],
      cache: false,
      run: [
        sh`pnpm async-pipeline publish npm --package .`,
        sh`pnpm async-pipeline release doctor --package .`
      ]
    }),
    "release.doctor": task({
      description: "Diagnose release consistency for the current version.",
      dependsOn: ["pack"],
      inputs: [...packageInputs, "dist/**"],
      cache: false,
      run: sh`pnpm async-pipeline release doctor --package .`
    })
  },
  jobs: {
    verify: job({
      target: "pack",
      trigger: ["pr", "main", "release", "manual"]
    }),
    snapshot: job({
      target: "snapshot",
      trigger: ["main"],
      env: {
        GITHUB_TOKEN: env.secret("GITHUB_TOKEN")
      },
      github: {
        permissions: {
          contents: "read",
          packages: "write"
        }
      }
    }),
    publish: job({
      target: "publish",
      trigger: ["manual", "release"],
      environment: {
        name: "npm-publish",
        url: "https://www.npmjs.com/package/@async/hygiene"
      },
      requires: {
        provenance: true
      },
      env: {
        GITHUB_TOKEN: env.secret("GITHUB_TOKEN"),
        NODE_AUTH_TOKEN: env.secret("NPM_TOKEN")
      },
      github: {
        permissions: {
          contents: "write",
          idToken: "write",
          packages: "write"
        }
      }
    }),
    "release-doctor": job({
      description: "Diagnose release consistency for the current version.",
      target: "release.doctor",
      trigger: ["manual"],
      env: {
        GITHUB_TOKEN: env.secret("GITHUB_TOKEN")
      },
      github: {
        permissions: {
          contents: "read",
          packages: "read"
        }
      }
    })
  }
});

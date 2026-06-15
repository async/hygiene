import { defineConfig } from "@async/hygiene";

export default defineConfig({
  mode: "package",
  gates: ["workflow", "unused", "package"],
  targets: {
    packages: [{ name: "@async/hygiene", path: "." }]
  },
  unused: {
    config: {
      entry: [
        "src/*.ts",
        "tests/**/*.test.js",
        "hygiene.config.ts"
      ],
      project: [
        "src/**/*.ts",
        "tests/**/*.js"
      ],
      ignoreDependencies: [
        "dependency-cruiser"
      ]
    }
  }
});

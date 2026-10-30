import { defineConfig } from "vitest/config";

// An explicit config stops Vitest from resolving a vite.config.* found in a
// parent directory outside this repository.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "app/**/*.test.ts"],
    environment: "node",
  },
});

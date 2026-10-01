import { defineConfig } from "vitest/config";

const e2e = process.env["AMA_E2E"] === "1";

export default defineConfig({
  test: {
    pool: "forks",
    testTimeout: 20_000,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**", ...(e2e ? [] : ["test/e2e/**"])],
    setupFiles: ["test/helpers/setup.ts"],
  },
});

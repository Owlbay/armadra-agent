import { defineConfig } from "vitest/config";

const e2e = process.env["AMA_E2E"] === "1";

export default defineConfig({
  test: {
    pool: "forks",
    // 内存回归测试（test/memory/、test/helpers/memory.ts）需要 globalThis.gc（docs/history/memory-plan.md D13）
    execArgv: ["--expose-gc"],
    testTimeout: 20_000,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "dist/**", ...(e2e ? [] : ["test/e2e/**"])],
    setupFiles: ["test/helpers/setup.ts"],
  },
});

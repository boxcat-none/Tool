import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // bench/ 只在明確指定時執行（見 bench/ink-capacity.test.ts）
    include: ["test/**/*.test.ts"],
  },
});

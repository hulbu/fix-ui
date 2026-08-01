import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Builds dist/ once for the suites that spawn the real bin.
    globalSetup: ["./vitest.global-setup.ts"],
    testTimeout: 30_000, // spawned bridges and real (short) review timeouts
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The tested surface is deliberately pure: no DOM, no chrome.* — the glue
    // that needs a browser is covered end-to-end by the Playwright suite.
    environment: "node",
  },
});

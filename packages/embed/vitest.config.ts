import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // `@hulbu/fixui-core` resolves through its `exports` to `dist/index.js`,
      // which is what a consumer gets and what the shipped bundle is built
      // from. Tests deliberately run against core's *source*: `pnpm test` must
      // work on a fresh clone, and a suite that silently exercises yesterday's
      // build is worse than one that fails to start.
      "@hulbu/fixui-core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "jsdom",
  },
});

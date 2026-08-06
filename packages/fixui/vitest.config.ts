import { defineConfig } from "vitest/config";

/**
 * One package, two worlds — so two vitest projects rather than one.
 *
 * `src/core` and `src/embed` are browser code and run in jsdom. `src/bridge` is
 * a daemon: it runs in node, and two of its suites spawn the *built*
 * `dist/bridge/cli.js`, so the build runs once in a global setup rather than in
 * each suite's `beforeAll`.
 *
 * The split is per-environment, not per-directory-for-its-own-sake: a bridge
 * test that got jsdom's `fetch` and a core test that got node's `document`
 * would each be testing something no user ever runs.
 */
export default defineConfig({
  test: {
    projects: [
      {
        // The build reads `jsx` from tsconfig.browser.json; vite would look for
        // a plain `tsconfig.json`, which this package deliberately does not
        // have (its two halves compile under different options). Saying it here
        // keeps the two in agreement.
        esbuild: { jsx: "automatic" },
        test: {
          name: "browser",
          include: ["src/core/**/*.test.ts", "src/embed/**/*.test.ts", "src/embed/**/*.test.tsx"],
          environment: "jsdom",
        },
      },
      {
        test: {
          name: "bridge",
          include: ["src/bridge/**/*.test.ts"],
          environment: "node",
          globalSetup: ["./vitest.global-setup.ts"],
          testTimeout: 30_000, // spawned bridges and real (short) review timeouts
        },
      },
    ],
  },
});

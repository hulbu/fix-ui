import { defineConfig } from "@playwright/test";

/**
 * One chromium project, one worker: every spec spawns a real bridge daemon and
 * the extension spec launches its own persistent context. Parallelism would buy
 * seconds and cost determinism.
 */
const PORT = Number(process.env.FIXUI_E2E_PORT ?? 4399);

export default defineConfig({
  testDir: "./tests",
  // Builds the bridge, the extension and the fixture bundles from source — a
  // green run has to be about the working tree, not a stale dist.
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node server.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/basic.html`,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  },
});

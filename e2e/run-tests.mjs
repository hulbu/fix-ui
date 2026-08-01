/**
 * `pnpm test` for the e2e package.
 *
 * This package is in the workspace, so `pnpm -r test` runs it — and Playwright
 * ships no browser and no install script (pnpm-workspace.yaml allowlists builds
 * for esbuild alone). On a fresh clone that means the repo's headline test
 * command would fail on a missing download rather than on the code.
 *
 * So: no browser, no run. It says exactly what to type, and exits 0 — a suite
 * that cannot run has proved nothing, and pretending otherwise (failing) makes
 * `pnpm -r test` useless as a first command. `pnpm --filter e2e test` after the
 * install line below is the real gate, and CI installs the browser.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);

let browser;
try {
  browser = chromium.executablePath();
} catch {
  browser = undefined; // older/newer Playwright that refuses to guess
}

if (!browser || !existsSync(browser)) {
  console.log(
    "e2e: skipped — no Chromium is downloaded for Playwright.\n" +
      "     Install it once, then run this suite:\n" +
      "       pnpm --filter e2e exec playwright install chromium\n" +
      "       pnpm --filter e2e test",
  );
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [require.resolve("@playwright/test/cli"), "test", ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);

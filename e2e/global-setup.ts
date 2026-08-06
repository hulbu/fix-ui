import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

/**
 * Everything the suite tests has to be built from source first — otherwise a
 * green run says nothing about the code in the working tree:
 *
 *   - `packages/bridge/dist/cli.js`, the daemon every spec spawns,
 *   - `packages/core/dist` and `packages/embed/dist`, because both packages now
 *     resolve through their `exports` to built JavaScript — so the fixture
 *     bundle below is built from the artefact that would be published, not from
 *     a TypeScript source tree no consumer ever sees,
 *   - `extension/dist/*`, loaded unpacked by the extension spec,
 *   - `fixtures/fixui.js`, an IIFE bundle of the npm embed (`@hulbu/fixui`),
 *     because a fixture page is a plain `<script src>` with no bundler, and
 *   - `fixtures/react-app.js`, React rendering a named component so
 *     `getReactComponentName` has something to find.
 *
 * Everything is bundled from the local workspace: the suite must run offline,
 * so no fixture may reach for a CDN.
 */
const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const fixtures = path.join(here, "fixtures");

async function buildWorkspacePackages(): Promise<void> {
  // `pnpm --filter` from the repo root, so this works however the suite was
  // invoked (`pnpm --filter e2e test`, `playwright test`, an IDE runner).
  await run("pnpm", ["--filter", "fixui-bridge", "build"], { cwd: repoRoot });
  // Core before embed, and both before the extension: the embed's build reads
  // core's emitted `.d.ts`, and the extension bundles core's emitted JS.
  await run("pnpm", ["--filter", "@hulbu/fixui-core", "build"], { cwd: repoRoot });
  await run("pnpm", ["--filter", "@hulbu/fixui", "build"], { cwd: repoRoot });
  await run("pnpm", ["--filter", "fix-ui-extension", "build"], { cwd: repoRoot });
}

async function buildFixtureBundles(): Promise<void> {
  await build({
    absWorkingDir: here,
    entryPoints: { fixui: path.join(here, "fixtures/src/embed.ts") },
    outdir: fixtures,
    bundle: true,
    format: "iife",
    globalName: "FixUi",
    target: ["chrome116"],
    logLevel: "warning",
  });

  await build({
    absWorkingDir: here,
    entryPoints: { "react-app": path.join(here, "fixtures/src/react-app.tsx") },
    outdir: fixtures,
    bundle: true,
    format: "iife",
    target: ["chrome116"],
    jsx: "automatic",
    // React's development build: the fiber expando component detection reads is
    // a development-build guarantee. Never minified — minification would mangle
    // `PricingCard` into a letter and the component assertion would prove
    // nothing.
    define: { "process.env.NODE_ENV": '"development"' },
    minify: false,
    logLevel: "warning",
  });
}

export default async function globalSetup(): Promise<void> {
  await buildWorkspacePackages();
  await buildFixtureBundles();
}

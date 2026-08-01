import { build } from "esbuild";
import { cp, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Four bundles into `dist/`, then a check that every file the extension names
 * actually exists — the failure mode this catches (a renamed bundle, a stale
 * manifest path) only shows up as a silent no-op inside Chrome otherwise.
 *
 * Load unpacked from `extension/`, not `extension/dist/`: the manifest lives at
 * the root and points into dist.
 *
 * `icons` are deliberately absent in v1 — no binary assets in this repo, so
 * Chrome shows its default puzzle piece.
 */
const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: {
    content: "src/content.ts",
    "main-world": "src/main-world.ts",
    background: "src/background.ts",
    options: "src/options.ts",
  },
  outdir: "dist",
  bundle: true,
  // Classic scripts everywhere: `executeScript` files and the MV3 service
  // worker are not modules unless the manifest says so, and nothing here needs
  // one.
  format: "iife",
  target: ["chrome116"],
  legalComments: "none",
  logLevel: "warning",
});

await cp(join(root, "src/options.html"), join(dist, "options.html"));

const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));

/** Every file path the manifest names, wherever it is nested. */
const referenced = new Set([
  "dist/background.js",
  "dist/content.js",
  "dist/main-world.js",
  "dist/options.js",
  "dist/options.html",
]);
const walk = (value) => {
  if (typeof value === "string") {
    if (/\.(js|html|css|png|svg)$/.test(value)) referenced.add(value);
  } else if (Array.isArray(value)) value.forEach(walk);
  else if (value && typeof value === "object") Object.values(value).forEach(walk);
};
walk(manifest);

// The injected scripts are named by the service worker, not by the manifest.
const worker = await readFile(join(dist, "background.js"), "utf8");
for (const [, file] of worker.matchAll(/"(dist\/[\w.-]+\.(?:js|html))"/g)) referenced.add(file);

const missing = [];
for (const file of [...referenced].sort()) {
  try {
    await stat(join(root, file));
  } catch {
    missing.push(file);
  }
}

if (missing.length > 0) {
  console.error(`fix-ui extension: referenced but missing:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

console.log(
  `fix-ui extension built — ${referenced.size} referenced files present (load unpacked from ${root})`,
);

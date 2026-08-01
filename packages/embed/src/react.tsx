"use client";

import { useEffect } from "react";

import { initFixUi, type FixUiOptions } from "./index";

/** Declared here so the package needs no `@types/node`. */
declare const process: { env: { NODE_ENV?: string } };

/**
 * Bundlers (webpack, Next, Vite's `define`) text-replace the literal
 * `process.env.NODE_ENV`, so in a production build the expression below becomes
 * `"production" === "production"` and this component no-ops with no `process`
 * anywhere in the bundle. That replacement is the whole mechanism, and it only
 * fires on the literal text — a `typeof process !== "undefined"` guard would
 * survive it and, in a browser bundle with no `process` shim, fall through to
 * dev and mount the picker on a production site.
 *
 * With no bundler at all the reference throws; that is treated as dev, which is
 * the honest reading of a component the author explicitly rendered ("dev-builds
 * only by convention", docs/design.md).
 */
function isProduction(): boolean {
  try {
    return process.env.NODE_ENV === "production";
  } catch {
    return false;
  }
}

/**
 * Mounts the fix-ui picker for as long as this component is mounted. Safe to
 * leave in a root layout: it renders nothing and never initializes in a
 * production build.
 *
 * Options are read once, on mount (prototype behavior) — a dev tool has no
 * business tearing its own UI down because a parent re-rendered with a fresh
 * object literal.
 */
export function FixUi(props: FixUiOptions): null {
  useEffect(() => {
    if (isProduction()) return;
    const fixui = initFixUi(props);
    return () => fixui.close();
  }, []); // deliberately empty: the options above are init-only
  return null;
}

export type { FixUiOptions };

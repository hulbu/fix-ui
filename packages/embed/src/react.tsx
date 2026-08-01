"use client";

import { useEffect } from "react";

import { initFixUi, type FixUiOptions } from "./index";

/**
 * Declared here so the package needs no `@types/node`: bundlers replace the
 * literal `process.env.NODE_ENV` text, and the `typeof` guard keeps a
 * bundler-less browser — where `process` genuinely does not exist — from
 * throwing a ReferenceError.
 */
declare const process: { env: { NODE_ENV?: string } };

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
    if (typeof process !== "undefined" && process.env.NODE_ENV === "production") return;
    const fixui = initFixUi(props);
    return () => fixui.close();
  }, []); // deliberately empty: the options above are init-only
  return null;
}

export type { FixUiOptions };

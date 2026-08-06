import type { ReactElement } from "react";

import { findDiscovery, noBridgeNotice } from "./find-discovery.js";
import { FixUi } from "./react.js";

/**
 * The Next adapter — one line in `app/layout.tsx` (or `pages/_app.tsx`):
 *
 * ```tsx
 * import { FixUiScript } from "fixui/next";
 * // …inside <body>:
 * <FixUiScript />
 * ```
 *
 * This is a **server** component on purpose, and deliberately has no
 * `"use client"`: the bridge's port and token live in a `0600` file on disk,
 * which a browser cannot read and an env var cannot know ahead of time (the
 * port is whatever the OS handed `fixui dev` this morning). So the server reads
 * the file at render and hands the two values down as props to the existing
 * client `<FixUi />`, which is where the picker actually mounts.
 *
 * It never throws. A dev tool that can break an app's render is worse than no
 * dev tool, so every failure — no file, half a file, a file we do not
 * understand, an unreadable path — lands in the same place: the picker mounts
 * with no bridge and queues notes, exactly as it does before the daemon exists.
 */
export interface FixUiScriptProps {
  /**
   * A human name for this page on the review channel — "app router",
   * "storefront". The agent sees it in `list_surfaces` and can aim a review at
   * this page rather than at every page of the project.
   */
  label?: string;
  /**
   * Where to start looking for `.fix-ui.json`; defaults to `process.cwd()`.
   * The escape hatch for a layout whose dev server runs somewhere other than
   * the project it belongs to — and the seam the tests render through.
   */
  cwd?: string;
}

/**
 * Bundler-replaceable by the literal text, same as `./react` — see the comment
 * there for why a `typeof process` guard would be a production hazard rather
 * than a safety net. Next replaces this in the server bundle too.
 */
function isProduction(): boolean {
  try {
    return process.env.NODE_ENV === "production";
  } catch {
    return false;
  }
}

/** Once per process, not once per request: a server component re-renders on
 *  every navigation, and a dev tool that prints a paragraph into your terminal
 *  on every page load gets deleted. */
let announced = false;

/**
 * @internal Test seam, not supported API — same bargain as `FixUiInternals` in
 * `./index`. "Once per process" is the behavior under test, and a test file is
 * one process.
 */
export function resetNoticeForTests(): void {
  announced = false;
}

export async function FixUiScript(props: FixUiScriptProps = {}): Promise<ReactElement | null> {
  if (isProduction()) return null;

  let from: string;
  try {
    from = props.cwd ?? process.cwd();
  } catch {
    from = "."; // no `process` at all — vanishingly unlikely on a server, still not a throw
  }

  const discovery = await findDiscovery(from);
  if (discovery === undefined && !announced) {
    announced = true;
    console.info(noBridgeNotice(from));
  }

  return (
    <FixUi
      {...(discovery === undefined
        ? {}
        : { bridgeUrl: `http://127.0.0.1:${discovery.port}`, token: discovery.token })}
      {...(props.label === undefined ? {} : { label: props.label })}
    />
  );
}

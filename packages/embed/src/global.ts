/**
 * The plain-HTML adapter, built to `dist/fixui.global.js` as an IIFE:
 *
 * ```html
 * <script src="/fixui.global.js" data-fixui data-port="51234" data-token="…"></script>
 * ```
 *
 * Loading it *is* the API — there is nothing to call. It reads the bridge's
 * port and token off its own tag, because a page has no other way to learn
 * them: the discovery file is `0600` on disk, and the port changes every run.
 * The Vite plugin and `fixui init` write those attributes for you; by hand,
 * copy them out of `.fix-ui.json`.
 *
 * Zero dependencies and no bundler needed on the consuming side, which is the
 * whole point: this is the adapter for the stacks we have not heard of.
 */
import { initFixUi, type FixUiOptions } from "./index";

const MARKER = "data-fixui";

/**
 * Our own `<script>`. `document.currentScript` is the exact answer while a
 * classic script is executing; it is `null` for `defer`, `async` and modules,
 * where the marker attribute is how we find ourselves instead.
 */
export function ownScript(): Element | null {
  if (typeof document === "undefined") return null;
  const current: unknown = document.currentScript;
  if (current !== null && current !== undefined && typeof current === "object") {
    return current as Element;
  }
  return document.querySelector(`script[${MARKER}]`);
}

/** What the tag says the embed should do. Anything missing or malformed is
 *  simply left out — the picker still mounts and queues. */
export function optionsFrom(script: Element | null): FixUiOptions {
  const port = attr(script, "data-port");
  const token = attr(script, "data-token");
  const label = attr(script, "data-label");
  return {
    ...(isPort(port) ? { bridgeUrl: `http://127.0.0.1:${port}` } : {}),
    ...(token === undefined ? {} : { token }),
    ...(label === undefined ? {} : { label }),
  };
}

function attr(script: Element | null, name: string): string | undefined {
  try {
    const value = script?.getAttribute(name);
    return value === null || value === undefined || value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

function isPort(value: string | undefined): value is string {
  if (value === undefined || !/^\d{1,5}$/.test(value)) return false;
  const port = Number(value);
  return port > 0 && port <= 65535;
}

/**
 * Runs on load. Wrapped, because this script is a `<script>` tag in somebody's
 * page: a throw here is a red error in their console and, in the wrong browser,
 * a stalled parse. A dev tool does not get to do that.
 */
export function bootFixUi(): void {
  try {
    if (typeof document === "undefined") return;
    initFixUi(optionsFrom(ownScript()));
  } catch (error) {
    console.error("[fix-ui] the picker failed to start", error);
  }
}

bootFixUi();

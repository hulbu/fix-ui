/**
 * Reading `.fix-ui.json` from the *other* side — the adapters that put the
 * picker into a page.
 *
 * The bridge writes this file (`packages/bridge/src/discovery.ts`); everything
 * here reads it. The shape is duplicated rather than imported on purpose: the
 * embed is a browser package with zero runtime dependencies, and a `next`
 * adapter that dragged the daemon into an app's `node_modules` would be a much
 * worse trade than thirty lines of parsing. `v` is what keeps the copy honest —
 * a future format is a `v` bump, and this reader will say "no bridge" rather
 * than guess at fields it has never seen.
 *
 * Node-only: the two callers (the Next server component, the Vite plugin) both
 * run in the dev server's process. Nothing in `./index` or `./global` imports
 * this.
 */
import { access, readFile } from "node:fs/promises";
import path from "node:path";

/** Mirrors `Discovery` in packages/bridge/src/discovery.ts. */
export interface Discovery {
  v: 1;
  port: number;
  token: string;
  pid: number;
}

export const DISCOVERY_FILE = ".fix-ui.json";

/**
 * The bridge published for the project `from` belongs to, or `undefined`.
 *
 * Walks up from `from` because a dev server's cwd is not reliably the project
 * root — Next can be started from a subdirectory, and a Vite root can be
 * `src/`. The walk stops at the first directory holding a `package.json`: that
 * is where the project ends, and a discovery file above it belongs to somebody
 * else's app. Sending this page's notes to a stranger's bridge would be worse
 * than finding nothing.
 *
 * Never throws. Missing, unreadable, truncated and unrecognized all mean the
 * same thing to a caller that must render either way: no bridge.
 */
export async function findDiscovery(from: string): Promise<Discovery | undefined> {
  let dir: string;
  try {
    dir = path.resolve(from);
  } catch {
    return undefined;
  }

  for (;;) {
    const discovery = await readDiscoveryAt(dir);
    if (discovery !== undefined) return discovery;
    if (await isFile(path.join(dir, "package.json"))) return undefined;

    const parent = path.dirname(dir);
    if (parent === dir) return undefined; // filesystem root
    dir = parent;
  }
}

/** The discovery file in exactly this directory, if it is one we understand. */
export async function readDiscoveryAt(dir: string): Promise<Discovery | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, DISCOVERY_FILE), "utf8");
  } catch {
    return undefined;
  }
  return parseDiscovery(raw);
}

export function parseDiscovery(raw: string): Discovery | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const { v, port, token, pid } = value as Record<string, unknown>;
  if (v !== 1) return undefined;
  if (!isPort(port) || !isPid(pid)) return undefined;
  if (typeof token !== "string" || token.trim() === "") return undefined;
  return { v: 1, port, token, pid };
}

export function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 65535;
}

function isPid(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

async function isFile(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The one line an adapter prints when it finds no bridge. Not a warning: with
 * no bridge the picker still works and queues, so this is the difference
 * between "broken" and "not wired up yet", and it names the fix.
 */
export function noBridgeNotice(dir: string): string {
  return (
    `[fix-ui] no ${DISCOVERY_FILE} found from ${dir} — the picker is on and will queue notes, ` +
    "but nothing is listening. Start your dev server through fix-ui: `fixui dev -- <your dev command>`."
  );
}

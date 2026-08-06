/**
 * `.fix-ui.json` — how everything that is not the bridge finds the bridge.
 *
 * The dev server owns the bridge's lifetime (`fixui dev -- <your dev command>`),
 * so the port is whatever the OS handed it that morning and the token is fresh
 * per run. Neither can be a constant any more, so the owner publishes both in
 * one file at the project root, and the two readers — the adapter in the page
 * and the MCP proxy the agent spawns — pick them up from there.
 *
 * Three rules make that safe to trust:
 *
 *   - **0600.** The token in this file is the review channel's shared secret;
 *     on a shared machine it is nobody else's business.
 *   - **Atomic.** Written to a temp file and renamed, so a reader never sees
 *     half a file, and a stale file's permissions can never be inherited.
 *   - **Never believed on its own.** A file is a claim about a process that may
 *     have been killed -9 an hour ago. `liveBridge` asks the port itself, and
 *     anything that does not answer as a fixui-bridge is treated as absent.
 */
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { HOST } from "./server.js";

/** What the owner publishes about itself. `v` is the file format, not the
 *  bridge's version — a future field is a `v` bump, and an older reader that
 *  does not know it treats the file as absent rather than guessing. */
export interface Discovery {
  v: 1;
  port: number;
  token: string;
  pid: number;
}

export const DISCOVERY_FILE = ".fix-ui.json";

/** How long a health probe may take before the port counts as dead. Short: a
 *  live loopback bridge answers in a millisecond, and an agent is waiting. */
const PROBE_TIMEOUT_MS = 1500;

function discoveryPath(dir: string): string {
  return path.join(dir, DISCOVERY_FILE);
}

/**
 * Publish the running bridge. Atomic, so a reader mid-write sees the old file
 * or the new one and never a truncated one — and so an existing file's mode is
 * replaced rather than kept (`writeFile`'s `mode` applies to *creation* only,
 * which would leave a world-readable leftover world-readable).
 */
export async function writeDiscovery(dir: string, discovery: Discovery): Promise<void> {
  const file = discoveryPath(dir);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(discovery)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temp, 0o600); // a temp file we did not create would keep its own
    await rename(temp, file);
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
}

/** The published bridge, or `undefined` — missing, unreadable, or not a
 *  discovery file we understand. Every one of those means "no bridge". */
export async function readDiscovery(dir: string): Promise<Discovery | undefined> {
  let raw: string;
  try {
    raw = await readFile(discoveryPath(dir), "utf8");
  } catch {
    return undefined;
  }
  return parseDiscovery(raw);
}

/** Exported for the adapters, which read the file themselves. */
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

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 65535;
}

function isPid(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

/** Unpublish. A file naming a bridge that is gone is worse than no file: it
 *  sends adapters and agents at a port that will answer nothing, or worse, at
 *  whatever process the OS handed that port to next. */
export async function removeDiscovery(dir: string): Promise<void> {
  await unlink(discoveryPath(dir)).catch(() => undefined);
}

/** Is a bridge of ours answering on this port *right now*? The identity check is
 *  the point: an ephemeral port is recycled, and the next holder is a stranger
 *  we must never proxy an agent's calls to. */
export async function liveBridge(port: number): Promise<boolean> {
  if (!isPort(port)) return false;
  try {
    const res = await fetch(`http://${HOST}:${port}/healthz`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    return ((await res.json()) as { name?: unknown }).name === "fixui-bridge";
  } catch {
    return false; // unreachable, too slow, or not speaking our JSON
  }
}

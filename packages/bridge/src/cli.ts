#!/usr/bin/env node
/**
 * `fixui-bridge` — the local daemon, and the MCP server an agent harness talks
 * to. Both, from one command, because the harness spawns this per session:
 *
 * - **Daemon:** the port is free, so this process binds it, owns the inbox
 *   files and the review broker, and serves MCP over stdio in the same process
 *   (the tools call the broker directly).
 * - **Proxy:** the port is already held by a fixui-bridge, so this process
 *   serves MCP over stdio alone and forwards its tools to that daemon's HTTP,
 *   scoped to *this* process's cwd (docs/design.md "One daemon, many projects").
 * - Anything else on the port is a hard error — we will not proxy to a stranger.
 *
 * **stdout belongs to the MCP transport.** Whenever MCP is wired up, every log
 * goes to stderr; one stray byte on stdout corrupts the client's JSON-RPC
 * framing. Whether MCP is wired at all is decided by a heuristic: a harness
 * hands this process a pipe on stdin, a human running `fixui-bridge` in a
 * terminal has a TTY. TTY → no MCP client is listening, so skip the MCP wiring
 * and log normally.
 */
import { randomBytes } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { httpTools, inProcessTools, serveMcpOverStdio } from "./mcp.js";
import { createBridgeServer, HOST } from "./server.js";

const DEFAULT_PORT = 3499;
const PROBE_TIMEOUT_MS = 1500;
/** Where the daemon leaves its review-channel token for local adapters. */
export const TOKEN_FILE = ".fix-ui.token";

/** A bad invocation: reported as a one-line message, never a stack trace. */
class UsageError extends Error {}

function portFlag(argv: string[]): string | undefined {
  for (const [index, arg] of argv.entries()) {
    if (arg === "--port") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--port requires a value");
      return value;
    }
    if (arg.startsWith("--port=")) return arg.slice("--port=".length);
  }
  return undefined;
}

/** `--port N` wins over `FIXUI_PORT`, which wins over the default. */
function parsePort(argv: string[], env: NodeJS.ProcessEnv): number {
  const raw = portFlag(argv) ?? env.FIXUI_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`invalid port ${JSON.stringify(raw)} — expected an integer 0-65535`);
  }
  return port;
}

/** Is the process holding this port one of ours? */
async function bridgeOwns(port: number): Promise<boolean> {
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

/**
 * The review channel's shared secret. `FIXUI_TOKEN` when the developer wants a
 * stable one (a checked-in dev script, a container); otherwise fresh per run,
 * because a token that outlives the daemon is a token that protects nothing.
 */
function parseToken(env: NodeJS.ProcessEnv): string {
  const configured = env.FIXUI_TOKEN?.trim();
  if (configured) return configured;
  return randomBytes(24).toString("base64url");
}

/**
 * The token a PROXY can honestly get hold of, for the one gated route it calls
 * (`GET /surfaces`). `FIXUI_TOKEN` when the developer set one for both
 * processes; otherwise `.fix-ui.token` in this process's own cwd — which is the
 * daemon's file exactly when the daemon runs in this same project (two sessions
 * on one repo, the common case). Neither → no token, and `list_surfaces` says
 * so instead of pretending nothing is connected.
 */
async function proxyToken(env: NodeJS.ProcessEnv, cwd: string): Promise<string | undefined> {
  const configured = env.FIXUI_TOKEN?.trim();
  if (configured) return configured;
  try {
    const stored = (await readFile(path.join(cwd, TOKEN_FILE), "utf8")).trim();
    return stored === "" ? undefined : stored;
  } catch {
    return undefined; // no file, or not ours to read
  }
}

async function main(): Promise<void> {
  const port = parsePort(process.argv.slice(2), process.env);
  const project = process.cwd();
  const servesMcp = !process.stdin.isTTY;
  const log = (message: string): void => {
    if (servesMcp) console.error(message);
    else console.log(message);
  };

  const token = parseToken(process.env);
  const server = createBridgeServer({ port, defaultProject: project, token });
  try {
    await server.start();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EADDRINUSE") throw cause;
    if (!(await bridgeOwns(port))) {
      throw new UsageError(`port ${port} is in use by another process — stop it or pass --port N`);
    }

    log(
      `fixui-bridge daemon already running on http://${HOST}:${port}` +
        ` — serving MCP as a proxy (project ${project})`,
    );
    // Nothing else for a terminal invocation to do; the daemon has the port.
    if (servesMcp) {
      const shared = await proxyToken(process.env, project);
      await serveMcpOverStdio(httpTools(`http://${HOST}:${port}`, project, shared));
    }
    return;
  }

  // The token file is written BEFORE the "listening" line, so anything that
  // waits for that line (the e2e harness, a dev script) can read the token the
  // moment it sees the port. 0600: it is a secret, on a shared machine too.
  const tokenFile = path.join(project, TOKEN_FILE);
  let wroteToken = false;
  try {
    await writeFile(tokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    wroteToken = true;
  } catch (cause) {
    log(`fixui-bridge could not write ${tokenFile}: ${(cause as Error).message}`);
  }

  log(`fixui-bridge listening on http://${HOST}:${server.port} (project ${project})`);
  log(
    `fixui-bridge review token: ${token}` +
      (wroteToken ? ` (also in ${tokenFile})` : "") +
      " — adapters need it for the review channel",
  );
  // Daemon mode owns the inbox, so it is the only mode that can announce inbox
  // changes to the harness (`feedback/updated`).
  if (servesMcp) {
    await serveMcpOverStdio(inProcessTools(server.broker, project), {
      onInboxChange: server.onInboxChange,
    });
  }

  const shutdown = (): void => {
    // A token file left behind after the daemon is gone points at a token that
    // opens nothing; the next daemon writes its own.
    const cleanup = wroteToken ? unlink(tokenFile).catch(() => undefined) : Promise.resolve();
    void cleanup.then(() =>
      server.stop().then(
        () => process.exit(0),
        () => process.exit(1),
      ),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((cause: unknown) => {
  console.error(
    cause instanceof UsageError
      ? cause.message
      : `fixui-bridge failed to start: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
  process.exitCode = 1;
});

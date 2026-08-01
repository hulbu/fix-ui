#!/usr/bin/env node
/**
 * `fixui-bridge` — start the local daemon for the project in the cwd.
 *
 * One daemon, many projects (docs/design.md): the first instance binds the
 * port and owns the inbox files; a later instance that finds the port held by
 * another fixui-bridge steps aside. Task 5 turns that branch into proxy mode
 * (the second instance keeps serving MCP, scoped to its own cwd).
 */
import { createBridgeServer, HOST } from "./server.js";

const DEFAULT_PORT = 3499;
const PROBE_TIMEOUT_MS = 1500;

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

async function main(): Promise<void> {
  const port = parsePort(process.argv.slice(2), process.env);
  const server = createBridgeServer({ port, defaultProject: process.cwd() });

  try {
    await server.start();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EADDRINUSE") throw cause;
    if (await bridgeOwns(port)) {
      console.log(`fixui-bridge daemon already running on http://${HOST}:${port}`);
      return;
    }
    throw new UsageError(`port ${port} is in use by another process — stop it or pass --port N`);
  }

  console.log(`fixui-bridge listening on http://${HOST}:${server.port} (project ${server.defaultProject})`);

  const shutdown = (): void => {
    void server.stop().then(() => process.exit(0));
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

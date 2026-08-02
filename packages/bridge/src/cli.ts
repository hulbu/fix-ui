#!/usr/bin/env node
/**
 * `fixui-bridge` — one command, two roles, decided by how the process starts.
 *
 * - **Owner** (`fixui-bridge dev -- <your dev command>`): binds a port,
 *   publishes `.fix-ui.json`, runs the dev command as its child and dies with
 *   it (dev.ts). The dev server owns the bridge's lifetime, so the sink is up
 *   exactly when the app is.
 * - **Proxy** (spawned by an agent harness over stdio, per `.mcp.json`): never
 *   binds anything. It reads `.fix-ui.json` for this project, checks the port
 *   really is a bridge, and forwards its MCP tools there. With no live owner it
 *   still serves MCP — every tool answering with the fix ("start your dev
 *   server") rather than an empty list that reads like "nothing to do".
 * - **Bare in a terminal** (a TTY on stdin, no subcommand): the owner role with
 *   no dev command to outlive — a bridge you start and stop yourself.
 *
 * The owner is looked up on every tool call, not once at startup: a harness
 * spawns its MCP servers when the session opens, which is routinely *before*
 * the developer starts the dev server. Resolving once would leave the agent
 * permanently blind to a bridge that came up a minute later.
 *
 * **stdout belongs to the MCP transport.** Whenever MCP is wired up, every log
 * goes to stderr; one stray byte on stdout corrupts the client's JSON-RPC
 * framing. Whether MCP is wired at all is decided by a heuristic: a harness
 * hands this process a pipe on stdin, a human running `fixui-bridge` in a
 * terminal has a TTY.
 */
import { randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { parseDevCommand, runOwner, type OwnerOptions } from "./dev.js";
import { liveBridge, readDiscovery } from "./discovery.js";
import { httpTools, serveMcpOverStdio, type InboxChanges, type ReviewTools } from "./mcp.js";
import { HOST } from "./server.js";
import { INBOX_FILE } from "./storage.js";

/** What every tool says when this project has no bridge running. It names the
 *  fix, because "no surfaces" reads to an agent like "nothing is wrong". */
export const NO_BRIDGE = "no fix-ui bridge for this project — start your dev server (npm run dev)";

/** A bad invocation: reported as a one-line message, never a stack trace. */
class UsageError extends Error {}

function portFlag(argv: string[]): string | undefined {
  for (const [index, arg] of argv.entries()) {
    if (arg === "--") return undefined; // past here it is the dev command's own
    if (arg === "--port") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--port requires a value");
      return value;
    }
    if (arg.startsWith("--port=")) return arg.slice("--port=".length);
  }
  return undefined;
}

/**
 * `--port N` wins over `FIXUI_PORT`. Neither → `undefined`, which the owner
 * turns into "bind 0 and publish what the OS gave me". There is no default
 * port any more: two projects on one machine each get their own bridge, and a
 * fixed number could only ever be right for one of them.
 */
function parsePort(argv: string[], env: NodeJS.ProcessEnv): number | undefined {
  const raw = portFlag(argv) ?? env.FIXUI_PORT;
  if (raw === undefined || raw === "") return undefined;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`invalid port ${JSON.stringify(raw)} — expected an integer 0-65535`);
  }
  return port;
}

/**
 * The review channel's shared secret. `FIXUI_TOKEN` when the developer wants a
 * stable one (a checked-in dev script, a container); otherwise fresh per run,
 * because a token that outlives the bridge is a token that protects nothing.
 */
function parseToken(env: NodeJS.ProcessEnv): string {
  const configured = env.FIXUI_TOKEN?.trim();
  if (configured) return configured;
  return randomBytes(24).toString("base64url");
}

interface Owner {
  port: number;
  /** The owner's review token, for the one gated route a proxy calls
   *  (`GET /surfaces`). Absent only when someone named a port by hand. */
  token: string | undefined;
}

/**
 * The bridge this proxy should talk to, or `undefined` for "there is none".
 *
 * An explicit `--port`/`FIXUI_PORT` is an instruction and wins, but only if
 * something of ours is actually there; otherwise the discovery file decides.
 * Both are checked against `/healthz` every time — a file, or a port from an
 * environment variable, is a claim about a process that may have died an hour
 * ago, and ephemeral ports get recycled to strangers.
 */
async function findOwner(
  project: string,
  explicitPort: number | undefined,
  env: NodeJS.ProcessEnv,
): Promise<Owner | undefined> {
  const configured = env.FIXUI_TOKEN?.trim() || undefined;
  const discovered = await readDiscovery(project);

  if (explicitPort !== undefined && (await liveBridge(explicitPort))) {
    const known = discovered?.port === explicitPort ? discovered.token : undefined;
    return { port: explicitPort, token: configured ?? known };
  }
  if (discovered !== undefined && (await liveBridge(discovered.port))) {
    return { port: discovered.port, token: configured ?? discovered.token };
  }
  return undefined;
}

/** The proxy's tools: the owner is found per call, so a dev server started
 *  after the harness spawned this process is picked up with no restart. */
function proxyTools(
  project: string,
  explicitPort: number | undefined,
  env: NodeJS.ProcessEnv,
): ReviewTools {
  const reach = async (): Promise<ReviewTools> => {
    const owner = await findOwner(project, explicitPort, env);
    if (owner === undefined) throw new Error(NO_BRIDGE);
    return httpTools(`http://${HOST}:${owner.port}`, project, owner.token);
  };

  return {
    async listFeedback(requested) {
      return (await reach()).listFeedback(requested);
    },
    async resolveFeedback(id, requested) {
      return (await reach()).resolveFeedback(id, requested);
    },
    async listSurfaces(requested) {
      return (await reach()).listSurfaces(requested);
    },
    async requestReview(input) {
      return (await reach()).requestReview(input);
    },
  };
}

/**
 * `feedback/updated` for the proxy (docs/agent-integration.md). The inbox is a
 * file in *this* process's project, so the notification the daemon used to send
 * from its own broker is a file watch here — the same promise to the harness,
 * made by the process the harness is actually connected to.
 *
 * The directory is watched rather than the file: the inbox does not exist until
 * the first note, and a rewrite (`resolve_feedback`) replaces it.
 */
function watchInbox(project: string): InboxChanges {
  return (listener) => {
    let timer: NodeJS.Timeout | undefined;
    const announce = (): void => {
      // Coalesced: one note can be several filesystem events, and the listener
      // is a "look again" hint, not a diff.
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        listener(project);
      }, 50);
      timer.unref(); // a pending hint must never hold the process open
    };

    let watcher: ReturnType<typeof watch> | undefined;
    try {
      watcher = watch(project, (_event, filename) => {
        if (filename === null || filename === INBOX_FILE) announce();
      });
      watcher.on("error", () => undefined); // a watch we lose is not a crash
    } catch {
      watcher = undefined; // no watches available: the tools still work
    }

    return () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    };
  };
}

/** The owner role, with the one failure a developer meets often said plainly. */
async function own(options: OwnerOptions): Promise<number> {
  try {
    return await runOwner(options);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new UsageError(
        `port ${options.port} is in use by another process — stop it or pass --port N`,
      );
    }
    throw cause;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const project = process.cwd();

  // ── Owner: the dev server's wrapper ──────────────────────────────────────
  if (argv[0] === "dev") {
    const rest = argv.slice(1);
    const command = parseDevCommand(rest);
    if (command.length === 0) {
      throw new UsageError(
        "fixui dev -- <command…> — the dev command to run under the bridge, e.g. fixui dev -- npm run dev",
      );
    }
    process.exitCode = await own({
      project,
      port: parsePort(rest, process.env) ?? 0,
      token: parseToken(process.env),
      command,
      // The dev command owns stdout; the wrapper's two lines go beside it.
      log: (message) => console.error(message),
    });
    return;
  }

  const explicitPort = parsePort(argv, process.env);

  // ── Owner: bare in a terminal, with nothing to outlive ────────────────────
  if (process.stdin.isTTY) {
    process.exitCode = await own({
      project,
      port: explicitPort ?? 0,
      token: parseToken(process.env),
      log: (message) => console.log(message),
    });
    return;
  }

  // ── Proxy: spawned by an agent harness ────────────────────────────────────
  const owner = await findOwner(project, explicitPort, process.env);
  console.error(
    owner === undefined
      ? `fixui-bridge: ${NO_BRIDGE} — serving MCP anyway, and looking again on every call` +
          ` (project ${project})`
      : `fixui-bridge serving MCP as a proxy to http://${HOST}:${owner.port} (project ${project})`,
  );

  // Even with no bridge in sight the tools are served: the agent must hear the
  // reason, and the dev server may well start while this session is open.
  await serveMcpOverStdio(proxyTools(project, explicitPort, process.env), {
    onInboxChange: watchInbox(project),
  });
}

main().catch((cause: unknown) => {
  console.error(
    cause instanceof UsageError
      ? cause.message
      : `fixui-bridge failed to start: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
  process.exitCode = 1;
});

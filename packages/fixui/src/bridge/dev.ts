/**
 * The **owner** role: `fixui dev -- <your dev command>`.
 *
 * The bridge's lifetime belongs to the dev server. This process binds the port,
 * publishes `.fix-ui.json`, runs the dev command as its child, and dies with
 * it. That is the whole point of the wrapper: a sink is running exactly when
 * the app is, so a note left in the browser is never queued against a bridge
 * that quietly went away, and nothing has to remember to shut anything down.
 *
 * The invariant every exit path here defends: **the bridge must not outlive the
 * dev command.** Clean exit, a signal, a command that cannot even be spawned —
 * each one ends with the port closed and the discovery file gone, because a
 * bridge still listening after the dev server is gone is a bridge that answers
 * a page for a project nobody is developing.
 */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import path from "node:path";
import { DISCOVERY_FILE, readDiscovery, removeDiscovery, writeDiscovery } from "./discovery.js";
import { createBridgeServer, HOST } from "./server.js";

/** The shell's own convention for "I could not run that command". */
const NOT_EXECUTABLE = 127;

export interface OwnerOptions {
  /** The project this bridge is for: its cwd, its inbox, its discovery file. */
  project: string;
  /** 0 lets the OS pick, which is the normal case — see docs/design.md. */
  port: number;
  token: string;
  /**
   * The dev command and its arguments. Absent → a bare bridge that serves HTTP
   * until it is signalled (`fixui-bridge` typed into a terminal), which is the
   * same lifetime story with the terminal itself playing the child.
   */
  command?: string[];
  /** Where the two startup lines go. Never stdout when a child owns stdout. */
  log(message: string): void;
}

/**
 * Bind, publish, run the command, clean up. Resolves with the exit code the
 * caller should exit with — the child's own, so `fixui dev -- vite` is as
 * transparent to a script as `vite` was.
 */
export async function runOwner(options: OwnerOptions): Promise<number> {
  const { project, token, log } = options;
  const server = createBridgeServer({ port: options.port, defaultProject: project, token });

  // Before anything else: a failure here (a port already taken) must leave no
  // discovery file, no listening socket and no dev command started.
  await server.start();

  let published = false;
  try {
    await writeDiscovery(project, { v: 1, port: server.port, token, pid: process.pid });
    published = true;
  } catch (cause) {
    await server.stop().catch(() => undefined);
    throw cause;
  }

  log(`fixui-bridge listening on http://${HOST}:${server.port} (project ${project})`);
  log(
    `fixui-bridge published ${path.join(project, DISCOVERY_FILE)}` +
      " — adapters and the agent's MCP server read the port and token from there",
  );

  let cleaning: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleaning ??= (async () => {
      // Only if it is still ours. A second `fixui dev` on the same project has
      // taken the file over by now, and taking its bridge away with ours would
      // be a stranger's bug to debug.
      if (published) {
        const current = await readDiscovery(project);
        if (current === undefined || current.pid === process.pid) await removeDiscovery(project);
      }
      await server.stop().catch(() => undefined);
    })();
    return cleaning;
  };

  try {
    return options.command === undefined
      ? await untilSignalled()
      : await runChild(options.command, project, log);
  } finally {
    await cleanup();
  }
}

/** A bare `fixui-bridge`: nothing to outlive, so it runs until the terminal
 *  ends it. */
function untilSignalled(): Promise<number> {
  let end: (code: number) => void = () => undefined;
  const signalled = new Promise<number>((resolve) => (end = resolve));
  const stop = (): void => end(0);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Both come off again: a signal listener keeps the event loop alive, so the
  // one that did not fire would stop the process from ever exiting.
  return signalled.finally(() => {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  });
}

/**
 * The dev command, wearing this process's stdio: its output is the developer's
 * output, and its stdin is the terminal, exactly as if the wrapper were not
 * there. Signals are forwarded rather than acted on, so it is the dev server
 * that decides how it wants to shut down; a second one of the same signal is
 * taken as "I meant it" and kills it outright.
 */
function runChild(command: string[], cwd: string, log: (message: string) => void): Promise<number> {
  const [file, ...args] = command as [string, ...string[]];
  const child = spawn(file, args, { cwd, stdio: "inherit" });

  const forwarded = new Set<NodeJS.Signals>();
  const forward = (signal: NodeJS.Signals): void => {
    if (forwarded.has(signal)) child.kill("SIGKILL");
    else {
      forwarded.add(signal);
      child.kill(signal);
    }
  };
  const onInterrupt = (): void => forward("SIGINT");
  const onTerminate = (): void => forward("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  return new Promise<number>((resolve) => {
    // `error` and `exit` are mutually exclusive in practice (a command that
    // never started never exits), but settling once is what makes that a
    // detail rather than a race.
    child.once("error", (cause: Error) => {
      log(`fixui dev could not run ${file}: ${cause.message}`);
      resolve(NOT_EXECUTABLE);
    });
    child.once("exit", (code, signal) => resolve(exitCodeFor(code, signal)));
  }).finally(() => {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  });
}

/** A child killed by a signal has no exit code; the shell's convention is
 *  128 + the signal number, and `fixui dev` is transparent about that too. */
function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal === null) return 1;
  const number = (constants.signals as unknown as Record<string, number | undefined>)[signal];
  return number === undefined ? 1 : 128 + number;
}

/**
 * `fixui dev [--port N] -- <command...>`. The `--` is the documented form and
 * the only unambiguous one; without it everything left after the flags is
 * taken as the command, because `fixui dev npm run dev` is what a hand types.
 */
export function parseDevCommand(args: string[]): string[] {
  const separator = args.indexOf("--");
  if (separator !== -1) return args.slice(separator + 1);

  const command: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (command.length === 0 && arg === "--port") {
      index += 1; // its value, which is not the command
      continue;
    }
    if (command.length === 0 && arg.startsWith("--")) continue;
    command.push(arg);
  }
  return command;
}

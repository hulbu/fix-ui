/**
 * The CLI is exercised as a real process against the *built* dist (built once
 * by vitest.global-setup.ts — so this suite still runs against a bin that
 * `pnpm --filter fixui-bridge build` produced). Every daemon it starts binds an
 * ephemeral port and runs in a temp cwd, so nothing here touches 3499 or this
 * repo's inbox.
 *
 * Note the spawns: `stdio[0]` is never a TTY, so every process here takes the
 * MCP branch — logs on stderr, stdout reserved for the MCP transport.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(packageDir, "dist", "cli.js");

interface CliRun {
  child: ChildProcess;
  exited: Promise<number>;
  readonly stdout: string;
  readonly stderr: string;
}

const running: CliRun[] = [];
const sockets: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const run of running.splice(0)) {
    run.child.kill("SIGTERM");
    await run.exited;
  }
  for (const socket of sockets.splice(0)) await new Promise((done) => socket.close(done));
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "fixui-cli-"));
  tempDirs.push(dir);
  return dir;
}

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): CliRun {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    // A pipe on stdin: not a TTY (MCP branch) and, unlike "ignore", it does not
    // hand the MCP transport an immediate EOF.
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => (stdout += chunk));
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => (stderr += chunk));

  const run: CliRun = {
    child,
    exited: new Promise((resolve) => child.on("exit", (code) => resolve(code ?? -1))),
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
  running.push(run);
  return run;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startDaemon(args: string[] = ["--port", "0"], env: NodeJS.ProcessEnv = {}): Promise<{
  run: CliRun;
  port: number;
}> {
  const run = runCli(args, await tempProject(), env);
  await waitFor(() => /listening on http:\/\/127\.0\.0\.1:\d+/.test(run.stderr), "the daemon to bind");
  return { run, port: Number(/127\.0\.0\.1:(\d+)/.exec(run.stderr)![1]) };
}

it("starts a loopback daemon on the requested port and answers /healthz", async () => {
  const { run, port } = await startDaemon(["--port", "0"]);

  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  expect(await res.json()).toMatchObject({ ok: true, name: "fixui-bridge" });
  // Logs go to stderr while MCP owns stdout — a single stray byte on stdout
  // would corrupt the client's JSON-RPC framing.
  expect(run.stdout).toBe("");
});

it("takes the port from FIXUI_PORT, and lets --port win over it", async () => {
  const busy = createServer();
  sockets.push(busy);
  await new Promise<void>((done) => busy.listen(0, "127.0.0.1", done));
  const envPort = (busy.address() as { port: number }).port;

  // --port 0 wins: the daemon binds something other than the occupied env port.
  const flagWins = await startDaemon(["--port", "0"], { FIXUI_PORT: String(envPort) });
  expect(flagWins.port).not.toBe(envPort);

  const fromEnv = await startDaemon([], { FIXUI_PORT: "0" });
  expect(fromEnv.port).toBeGreaterThan(0);
});

it("keeps serving MCP as a proxy when a fixui-bridge daemon already owns the port", async () => {
  const { port } = await startDaemon();

  const second = runCli(["--port", String(port)], await tempProject());

  await waitFor(() => /proxy/.test(second.stderr), "the proxy to announce itself");
  expect(second.stderr).toContain(`http://127.0.0.1:${port}`);
  expect(second.stdout).toBe("");
  expect(second.child.exitCode).toBeNull(); // still there, serving MCP for its own cwd
});

it("exits 1 when the port is held by something that is not the bridge", async () => {
  const squatter = createServer((socket) => socket.destroy());
  sockets.push(squatter);
  await new Promise<void>((done) => squatter.listen(0, "127.0.0.1", done));
  const port = (squatter.address() as { port: number }).port;

  const run = runCli(["--port", String(port)], await tempProject());

  expect(await run.exited).toBe(1);
  expect(run.stderr).toContain(String(port));
});

it("exits 1 on an unusable --port value", async () => {
  const run = runCli(["--port", "banana"], await tempProject());

  expect(await run.exited).toBe(1);
  expect(run.stderr).toContain("banana");
});

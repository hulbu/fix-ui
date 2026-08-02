/**
 * `fixui dev -- <command>` — the owner role, exercised as a real process tree
 * against the *built* dist (built once by vitest.global-setup.ts).
 *
 * The property every test here is really about: **the bridge does not outlive
 * the dev command.** A bridge still holding a port after the dev server is gone
 * is a bridge a page can still reach, publishing a `.fix-ui.json` that points at
 * a project nobody is developing — so every exit path (clean exit, a signal, a
 * command that cannot even be spawned) is checked for the port going away and
 * the discovery file going with it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { DISCOVERY_FILE, type Discovery } from "./discovery.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(packageDir, "dist", "cli.js");

/** A dev command that does nothing until it is signalled — a stand-in for a
 *  dev server, which is exactly a process that never ends on its own. */
const SLEEPER = [process.execPath, "-e", "setInterval(() => {}, 1 << 30)"];

interface DevRun {
  child: ChildProcess;
  exited: Promise<number>;
  readonly stderr: string;
  readonly stdout: string;
}

const running: DevRun[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const run of running.splice(0)) {
    run.child.kill("SIGKILL");
    await run.exited;
  }
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "fixui-dev-"));
  tempDirs.push(dir);
  return dir;
}

function runDev(
  cwd: string,
  command: string[],
  options: { flags?: string[]; env?: NodeJS.ProcessEnv } = {},
): DevRun {
  const child = spawn(
    process.execPath,
    [cliPath, "dev", ...(options.flags ?? []), "--", ...command],
    { cwd, env: { ...process.env, ...options.env }, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => (stdout += chunk));
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => (stderr += chunk));

  const run: DevRun = {
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

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function discoveryPath(project: string): string {
  return path.join(project, DISCOVERY_FILE);
}

async function readDiscoveryFile(project: string): Promise<Discovery | undefined> {
  try {
    return JSON.parse(await readFile(discoveryPath(project), "utf8")) as Discovery;
  } catch {
    return undefined;
  }
}

/** The port `fixui dev` announced on stderr — readable after it has exited,
 *  unlike the discovery file, which it takes with it. */
function announcedPort(run: DevRun): number {
  const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(run.stderr);
  if (!match) throw new Error(`no port in stderr: ${run.stderr}`);
  return Number(match[1]);
}

function waitForPort(run: DevRun): Promise<number> {
  return waitFor(() => {
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(run.stderr);
    return match ? Number(match[1]) : undefined;
  }, "the bridge to announce its port");
}

async function answers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

it("fixui dev writes .fix-ui.json at 0600 with the bound port, and removes it when the child exits", async () => {
  const project = await tempProject();
  const run = runDev(project, SLEEPER);

  const discovery = await waitFor(() => readDiscoveryFile(project), "the discovery file");
  expect(discovery).toMatchObject({ v: 1, pid: run.child.pid });
  // The file lands BEFORE the announcement, so whatever waits for that line can
  // read the port and token the moment it appears — never half a startup.
  expect(discovery.port).toBe(await waitForPort(run));
  expect(typeof discovery.token).toBe("string");
  expect(discovery.token.length).toBeGreaterThan(0);
  // A secret, on a shared machine too.
  expect((await stat(discoveryPath(project))).mode & 0o777).toBe(0o600);

  // The port is a real bridge for this project…
  const health = await fetch(`http://127.0.0.1:${discovery.port}/healthz`);
  expect(await health.json()).toMatchObject({ ok: true, name: "fixui-bridge" });

  // …and the token in the file is the one it actually enforces.
  const refused = await fetch(`http://127.0.0.1:${discovery.port}/events`);
  expect(refused.status).toBe(401);
  await refused.body?.cancel();
  const watcher = new AbortController();
  const accepted = await fetch(
    `http://127.0.0.1:${discovery.port}/events?token=${encodeURIComponent(discovery.token)}`,
    { signal: watcher.signal },
  );
  expect(accepted.status).toBe(200);
  watcher.abort();

  // The dev command ends (here: by being signalled) → the file goes with it.
  run.child.kill("SIGTERM");
  expect(await run.exited).toBe(143); // 128 + SIGTERM, the child's own death
  expect(await readDiscoveryFile(project)).toBeUndefined();
  expect(await answers(discovery.port)).toBe(false);
});

it("fixui dev exits with the child's exit code and leaves no bridge listening", async () => {
  const project = await tempProject();
  const run = runDev(project, [process.execPath, "-e", "process.exit(17)"]);

  expect(await run.exited).toBe(17);
  expect(await answers(announcedPort(run))).toBe(false);
  expect(await readDiscoveryFile(project)).toBeUndefined();
});

it("fixui dev forwards SIGINT to the child and still cleans up", async () => {
  const project = await tempProject();
  const ready = path.join(project, "ready");
  const marker = path.join(project, "sigint-seen");
  // The child handles SIGINT itself, so the marker can only exist if the signal
  // was forwarded: the test signals `fixui dev` alone, never the process group.
  const run = runDev(project, [
    process.execPath,
    "-e",
    `const fs = require("node:fs");
     process.on("SIGINT", () => { fs.writeFileSync(${JSON.stringify(marker)}, "seen"); process.exit(3); });
     fs.writeFileSync(${JSON.stringify(ready)}, "ready");
     setInterval(() => {}, 1 << 30);`,
  ]);

  const discovery = await waitFor(() => readDiscoveryFile(project), "the discovery file");
  await waitFor(async () => (await readFile(ready, "utf8").catch(() => undefined)), "the child");

  run.child.kill("SIGINT");

  expect(await run.exited).toBe(3); // the child's code, not ours
  expect(await readFile(marker, "utf8")).toBe("seen");
  expect(await readDiscoveryFile(project)).toBeUndefined();
  expect(await answers(discovery.port)).toBe(false);
});

it("takes the bridge down when the dev command cannot be spawned at all", async () => {
  const project = await tempProject();
  const run = runDev(project, ["definitely-not-a-command-on-this-machine"]);

  expect(await run.exited).toBe(127);
  expect(run.stderr).toContain("definitely-not-a-command-on-this-machine");
  expect(await readDiscoveryFile(project)).toBeUndefined();
  expect(await answers(announcedPort(run))).toBe(false);
});

it("refuses to start when the requested port is taken, and never runs the dev command", async () => {
  const project = await tempProject();
  const squatter = createServer((socket) => socket.destroy());
  await new Promise<void>((done) => squatter.listen(0, "127.0.0.1", done));
  const port = (squatter.address() as AddressInfo).port;

  const marker = path.join(project, "ran");
  const run = runDev(
    project,
    [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
    { flags: ["--port", String(port)] },
  );

  expect(await run.exited).toBe(1);
  expect(run.stderr).toContain(String(port));
  expect(await readFile(marker, "utf8").catch(() => undefined)).toBeUndefined();
  expect(await readDiscoveryFile(project)).toBeUndefined();

  await new Promise((done) => squatter.close(done));
});

it("takes the port from --port and FIXUI_PORT, and the token from FIXUI_TOKEN", async () => {
  const project = await tempProject();
  const run = runDev(project, SLEEPER, { env: { FIXUI_TOKEN: "stable-dev-token" } });
  const discovery = await waitFor(() => readDiscoveryFile(project), "the discovery file");
  expect(discovery.token).toBe("stable-dev-token");

  // An explicit port is honoured verbatim, from the flag and from the env.
  const free = createServer();
  await new Promise<void>((done) => free.listen(0, "127.0.0.1", done));
  const wanted = (free.address() as AddressInfo).port;
  await new Promise((done) => free.close(done));

  const flagged = runDev(await tempProject(), SLEEPER, { flags: ["--port", String(wanted)] });
  expect(await waitForPort(flagged)).toBe(wanted);

  const fromEnv = runDev(await tempProject(), SLEEPER, { env: { FIXUI_PORT: "0" } });
  expect(await waitForPort(fromEnv)).toBeGreaterThan(0);
});

it("says what to run when the dev command is missing", async () => {
  const project = await tempProject();
  const child = spawn(process.execPath, [cliPath, "dev"], {
    cwd: project,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

  expect(await new Promise((done) => child.on("exit", done))).toBe(1);
  expect(stderr).toContain("fixui dev --");
  expect(await readDiscoveryFile(project)).toBeUndefined();
});

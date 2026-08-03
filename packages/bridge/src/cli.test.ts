/**
 * The CLI is exercised as a real process against the *built* dist (built once
 * by vitest.global-setup.ts — so this suite still runs against a bin that
 * `pnpm --filter fixui-bridge build` produced).
 *
 * This file is about the **proxy** role: a `fixui-bridge` an agent harness
 * spawned over stdio (`.mcp.json`), which never binds a port of its own. It
 * finds the bridge the dev server owns through `.fix-ui.json` and forwards to
 * it; with no live owner it still serves MCP, but every tool says so. The owner
 * role lives in dev.test.ts.
 *
 * Note the spawns: `stdio[0]` is never a TTY, so every process here takes the
 * agent branch — logs on stderr, stdout reserved for the MCP transport.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, it } from "vitest";
import { DISCOVERY_FILE, type Discovery } from "./discovery.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(packageDir, "dist", "cli.js");

/** A dev command that ends only when it is signalled. */
const SLEEPER = [process.execPath, "-e", "setInterval(() => {}, 1 << 30)"];

interface CliRun {
  child: ChildProcess;
  exited: Promise<number>;
  readonly stdout: string;
  readonly stderr: string;
}

const running: CliRun[] = [];
const clients: Client[] = [];
const sockets: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const run of running.splice(0)) {
    run.child.kill("SIGKILL");
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
    // A pipe on stdin: not a TTY (the agent branch) and, unlike "ignore", it
    // does not hand the MCP transport an immediate EOF.
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

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A dev server under `fixui dev`: the owner of the bridge and of the
 *  discovery file every proxy in these tests is looking for. */
async function startOwner(
  project: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ run: CliRun; discovery: Discovery }> {
  const run = runCli(["dev", "--", ...SLEEPER], project, env);
  const discovery = await waitFor(async () => {
    const raw = await readFile(path.join(project, DISCOVERY_FILE), "utf8").catch(() => undefined);
    return raw === undefined ? undefined : (JSON.parse(raw) as Discovery);
  }, "the dev server to publish its bridge");
  return { run, discovery };
}

/** An MCP client over a `fixui-bridge` spawned the way a harness spawns it. */
async function connectAgent(
  cwd: string,
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<{ client: Client; stderr: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, ...args],
    cwd,
    stderr: "pipe",
    env: { ...(process.env as Record<string, string>), ...env },
  });
  let stderr = "";
  const client = new Client({ name: "fixui-cli-test", version: "0.0.0" });
  clients.push(client);
  await client.connect(transport);
  transport.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  return { client, stderr: () => stderr };
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return client.callTool({ name, arguments: args }) as Promise<ToolResult>;
}

/** A port that was bound and released: nothing answers there now. */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise((done) => server.close(done));
  return port;
}

it("an agent-spawned bridge proxies to the port named in a live discovery file", async () => {
  const project = await tempProject();
  const { discovery } = await startOwner(project);

  // A page connects to the OWNER's bridge — the proxy has no bridge of its own,
  // so seeing this surface at all means the discovery file was followed.
  const watcher = new AbortController();
  const query = new URLSearchParams({
    project,
    token: discovery.token,
    label: "the dev server's window",
    adapter: "embed",
  });
  const stream = await fetch(`http://127.0.0.1:${discovery.port}/events?${query.toString()}`, {
    signal: watcher.signal,
  });
  expect(stream.status).toBe(200);

  try {
    // No --port, no FIXUI_TOKEN: everything it needs is in `.fix-ui.json`.
    const { client, stderr } = await connectAgent(project);

    // `/surfaces` is token-gated, so this also proves the proxy used the
    // token from the discovery file and not a guess.
    const listed = await call(client, "list_surfaces");
    expect(listed.isError ?? false, JSON.stringify(listed.content)).toBe(false);
    const { surfaces } = JSON.parse(listed.content[0]!.text) as {
      surfaces: { project: string; label: string }[];
    };
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).toMatchObject({ project, label: "the dev server's window" });

    // And the held call travels to the owner's broker, which answers it.
    const review = await call(client, "request_review", { prompt: "anyone there?" });
    expect(JSON.parse(review.content[0]!.text)).toMatchObject({ verdict: "no-reviewer" });

    await waitFor(() => (/proxy/.test(stderr()) ? true : undefined), "the proxy to say so");
    expect(stderr()).toContain(String(discovery.port));
  } finally {
    watcher.abort();
  }
});

it("an agent-spawned bridge with no live owner answers tools with an actionable error, not an empty list", async () => {
  const { client } = await connectAgent(await tempProject());

  // The tools are still there — the capability exists, the bridge does not.
  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
    "list_feedback",
    "list_surfaces",
    "request_review",
    "resolve_feedback",
  ]);

  for (const [name, args] of [
    ["list_feedback", {}],
    ["list_surfaces", {}],
    ["resolve_feedback", { id: "whatever" }],
    ["request_review", { prompt: "look at the hero" }],
  ] as const) {
    const result = await call(client, name, args);
    expect(result.isError, name).toBe(true);
    expect(result.content[0]!.text, name).toContain("no fix-ui bridge for this project");
    expect(result.content[0]!.text, name).toContain("npm run dev");
  }
});

it("a discovery file whose port answers nothing is treated as absent", async () => {
  const project = await tempProject();
  await writeFile(
    path.join(project, DISCOVERY_FILE),
    JSON.stringify({ v: 1, port: await deadPort(), token: "left-over", pid: 999_999 }),
    { mode: 0o600 },
  );

  const { client } = await connectAgent(project);

  const result = await call(client, "list_feedback");
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain("no fix-ui bridge for this project");
});

it("lets an explicit --port name the bridge to proxy to, over the discovery file", async () => {
  const ownerProject = await tempProject();
  const { discovery } = await startOwner(ownerProject, { FIXUI_TOKEN: "shared-token-for-both" });

  // A second project, with a discovery file of its own that leads nowhere.
  const project = await tempProject();
  await writeFile(
    path.join(project, DISCOVERY_FILE),
    JSON.stringify({ v: 1, port: await deadPort(), token: "left-over", pid: 999_999 }),
    { mode: 0o600 },
  );

  const { client } = await connectAgent(project, ["--port", String(discovery.port)], {
    FIXUI_TOKEN: "shared-token-for-both",
  });

  // Scoped to THIS process's project, forwarded to the named bridge.
  const listed = await call(client, "list_feedback");
  expect(listed.isError ?? false, JSON.stringify(listed.content)).toBe(false);
  expect(JSON.parse(listed.content[0]!.text)).toEqual({ entries: [] });
});

it("exits 1 on an unusable --port value", async () => {
  const run = runCli(["--port", "banana"], await tempProject());

  expect(await run.exited).toBe(1);
  expect(run.stderr).toContain("banana");
});

it("keeps stdout clear for the MCP transport", async () => {
  const project = await tempProject();
  const { discovery } = await startOwner(project);
  const proxy = runCli([], project);

  await waitFor(() => (/proxy/.test(proxy.stderr) ? true : undefined), "the proxy to announce itself");
  expect(proxy.stderr).toContain(`http://127.0.0.1:${discovery.port}`);
  expect(proxy.stdout).toBe("");
  expect(proxy.child.exitCode).toBeNull(); // still there, serving MCP for its own cwd
});

/**
 * `init` is the one subcommand that neither binds nor serves: the real bin,
 * run once in a project, with the dependency already present so nothing here
 * reaches the network.
 */
it("init wires a project up and prints what it changed", async () => {
  const project = await tempProject();
  await writeFile(
    path.join(project, "package.json"),
    `${JSON.stringify(
      {
        name: "demo",
        scripts: { dev: "vite" },
        devDependencies: {
          vite: "^6.0.0",
          "@hulbu/fixui": "^0.0.1",
          "fixui-bridge": "^0.0.1",
        },
      },
      undefined,
      2,
    )}\n`,
  );
  await writeFile(path.join(project, "vite.config.ts"), "export default { plugins: [] };\n");

  const run = runCli(["init"], project);
  expect(await run.exited).toBe(0);

  expect(JSON.parse(await readFile(path.join(project, ".mcp.json"), "utf8"))).toEqual({
    mcpServers: { fixui: { command: "npx", args: ["fixui-bridge"] } },
  });
  expect(await readFile(path.join(project, "package.json"), "utf8")).toContain(
    "fixui dev -- vite",
  );
  expect(await readFile(path.join(project, "vite.config.ts"), "utf8")).toContain("fixui()");
  expect(await readFile(path.join(project, ".claude/skills/fix-ui/SKILL.md"), "utf8")).toContain(
    "name: fix-ui",
  );
  expect(run.stdout).toContain("Next:");
});

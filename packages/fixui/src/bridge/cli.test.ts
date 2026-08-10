/**
 * The CLI is exercised as a real process against the *built* dist (built once
 * by vitest.global-setup.ts — so this suite still runs against a bin that
 * `pnpm --filter fixui build` produced).
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
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, it } from "vitest";
import { DISCOVERY_FILE, type Discovery } from "./discovery.js";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const cliPath = path.join(packageDir, "dist", "bridge", "cli.js");

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

/**
 * A project directory named the way the processes under test will name it.
 *
 * `realpath` is not decoration. A project is routed by its path *string*
 * (storage.ts `resolveProject` resolves but never canonicalises), and a spawned
 * child's `process.cwd()` comes back canonicalised by the kernel. On macOS
 * `tmpdir()` is `/var/folders/…`, where `/var` is a symlink to `/private/var`,
 * so a test that hands a page the raw `mkdtemp` path files that page under a
 * project name no spawned bridge here will ever use — the page and the agent
 * end up on two different projects that happen to be the same directory. On
 * Linux `/tmp` is real and the two agree, which is exactly the kind of
 * difference that makes a suite pass on one CI runner and hang on another.
 */
async function tempProject(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "fixui-cli-")));
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

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

/**
 * The page's half of the review channel, parsed as it arrives.
 *
 * The body is *consumed*, not merely opened: that is what an adapter does, and
 * a response nobody reads holds its connection checked out for as long as the
 * test runs. Frames land in an array the assertions poll with `waitFor`.
 */
function readEvents(response: Response): Frame[] {
  const frames: Frame[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          // Comment lines (`: connected`, `: heartbeat`) carry neither.
          if (event !== undefined && data !== undefined) {
            frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
          }
        }
      }
    } catch {
      // The test aborts this stream in its `finally`; a torn read is the end of
      // the subscription, not a failure to report.
    }
  })();
  return frames;
}

/** The human's answer, posted the way the adapter posts it. */
async function submitVerdict(port: number, token: string, reviewId: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/reviews/${reviewId}/verdict`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fixui-token": token },
    body: JSON.stringify({ verdict: "approved", entryIds: [] }),
  });
  await response.arrayBuffer(); // read it: an unread body keeps its socket
  return response.status;
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
  const events = readEvents(stream);

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

    // And the held call travels to the owner's broker, which raises it on the
    // page above — the whole round trip, proxy to broker to page and back.
    // Not awaited yet: the broker holds it open until the human answers, which
    // is the next two lines.
    const review = call(client, "request_review", { prompt: "anyone there?" });
    // Handled here as well as at the `await` below, so that a failure *before*
    // that await reports itself rather than an unhandled rejection.
    void review.catch(() => undefined);
    const requested = await waitFor(
      () => events.find((frame) => frame.event === "review-requested")?.data,
      "the page to be asked for a review",
    );
    expect(await submitVerdict(discovery.port, discovery.token, String(requested.reviewId))).toBe(
      200,
    );
    expect(JSON.parse((await review).content[0]!.text)).toMatchObject({ verdict: "approved" });

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
    "start_fix_ui_session",
  ]);

  for (const [name, args] of [
    ["list_feedback", {}],
    ["list_surfaces", {}],
    ["resolve_feedback", { id: "whatever" }],
    ["request_review", { prompt: "look at the hero" }],
    ["start_fix_ui_session", {}],
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
          fixui: "^0.1.0",
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
    mcpServers: { fixui: { command: "npx", args: ["fixui"] } },
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

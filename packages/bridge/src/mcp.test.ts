/**
 * The MCP surface, exercised the way an agent harness exercises it: a real SDK
 * client talking JSON-RPC over stdio to a *spawned* `dist/cli.js` (built once by
 * the vitest global setup). Both process modes are covered — the daemon that
 * binds the port and serves its tools in-process, and the proxy that finds the
 * port already held by a fixui-bridge and forwards its tools over HTTP.
 *
 * Every spawn passes `--port 0` (or an ephemeral daemon's port), so a real 3499
 * daemon on the developer's machine is never touched.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it } from "vitest";
import {
  BusyError,
  createReviewBroker,
  type ReviewBroker,
  type ReviewOutcome,
} from "./broker.js";
import { createMcpServer, httpTools, inProcessTools, type ReviewTools } from "./mcp.js";
import { createBridgeServer } from "./server.js";
import { inboxPath } from "./storage.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const cliPath = path.join(packageDir, "dist", "cli.js");

const clients: Client[] = [];
const daemons: ChildProcess[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const child of daemons.splice(0)) {
    child.kill("SIGTERM");
    await new Promise((done) => child.on("exit", done));
  }
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempProject(entries: Record<string, unknown>[] = []): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "fixui-mcp-"));
  tempDirs.push(dir);
  if (entries.length > 0) {
    await writeFile(inboxPath(dir), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  return dir;
}

function sampleEntry(id: string, note: string): Record<string, unknown> {
  return {
    v: 1,
    id,
    note,
    selector: `#${id}`,
    url: "http://localhost:4001/",
    viewport: { width: 1280, height: 800 },
    userAgent: "test-agent",
    createdAt: "2026-07-31T09:00:00.000Z",
  };
}

/** An MCP client over a spawned `fixui-bridge`. stderr is piped so the bridge's
 *  logs stay out of the test output — and so this suite can read them. */
async function connect(
  cwd: string,
  args: string[] = ["--port", "0"],
  env: Record<string, string> = {},
): Promise<{
  client: Client;
  stderr: () => string;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, ...args],
    cwd,
    stderr: "pipe",
    ...(Object.keys(env).length === 0
      ? {}
      : { env: { ...(process.env as Record<string, string>), ...env } }),
  });
  let stderr = "";
  const client = new Client({ name: "fixui-mcp-test", version: "0.0.0" });
  clients.push(client);
  await client.connect(transport);
  transport.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  return { client, stderr: () => stderr };
}

/** The port the spawned bridge logged (stderr — stdout is the MCP transport).
 *  Node buffers a paused stream, so a listener attached after the line was
 *  written still sees it. */
async function waitForPort(stderr: () => string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr());
    if (match) return Number(match[1]);
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`bridge never logged a port; stderr: ${stderr()}`);
}

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  expect(result.isError ?? false, JSON.stringify(result.content)).toBe(false);
  expect(result.content[0]!.type).toBe("text");
  return JSON.parse(result.content[0]!.text);
}

async function inboxIds(dir: string): Promise<string[]> {
  const raw = await readFile(inboxPath(dir), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { id: string }).id);
}

/** Start a daemon the way a first session does, and read its port off stderr. */
async function startDaemon(
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ port: number; stdout: () => string }> {
  const child = spawn(process.execPath, [cliPath, "--port", "0"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  daemons.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = /127\.0\.0\.1:(\d+)/.exec(stderr);
    if (match) return { port: Number(match[1]), stdout: () => stdout };
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`daemon never bound a port; stderr: ${stderr}`);
}

it("lists tools; list_feedback and resolve_feedback round-trip against a temp project", async () => {
  const dir = await tempProject([sampleEntry("a", "make this bigger"), sampleEntry("b", "wrong copy")]);
  const { client } = await connect(dir);

  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
    "list_feedback",
    "list_surfaces",
    "request_review",
    "resolve_feedback",
  ]);
  // The workflow has to be in the descriptions: an agent only learns to
  // enumerate pages from the tool that answered `no-reviewer`.
  const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
  expect(byName.get("request_review")!.description).toContain("list_surfaces");
  expect(byName.get("request_review")!.inputSchema.properties).toHaveProperty("surfaceId");
  expect(byName.get("list_surfaces")!.description).toMatch(/no-reviewer/);
  for (const tool of tools.tools) {
    expect(typeof tool.description).toBe("string");
    expect(tool.inputSchema.type).toBe("object");
  }

  // No project argument: the tools follow the process's cwd.
  const listed = await callJson(client, "list_feedback", {});
  expect(listed.entries.map((entry: any) => entry.id)).toEqual(["a", "b"]);
  expect(listed.entries[0]).toMatchObject({ note: "make this bigger", selector: "#a" });

  expect(await callJson(client, "resolve_feedback", { id: "a" })).toEqual({ ok: true });
  expect(await inboxIds(dir)).toEqual(["b"]);
  expect((await callJson(client, "list_feedback", {})).entries.map((e: any) => e.id)).toEqual(["b"]);

  // An explicit project routes elsewhere; a bogus one is a tool error.
  const other = await tempProject([sampleEntry("c", "elsewhere")]);
  expect((await callJson(client, "list_feedback", { project: other })).entries).toHaveLength(1);
  const failed = (await client.callTool({
    name: "list_feedback",
    arguments: { project: "relative/path" },
  })) as { isError?: boolean; content: { text: string }[] };
  expect(failed.isError).toBe(true);
  expect(failed.content[0]!.text).toContain("absolute path");
});

it("request_review returns no-reviewer immediately when nobody is connected", async () => {
  const dir = await tempProject();
  const { client } = await connect(dir);

  const started = Date.now();
  const outcome = await callJson(client, "request_review", { prompt: "Review the hero section" });

  expect(outcome).toEqual({ verdict: "no-reviewer", entries: [], durationMs: 0 });
  expect(Date.now() - started).toBeLessThan(5000); // immediate, not held for 600s

  const empty = (await client.callTool({
    name: "request_review",
    arguments: { prompt: "   " },
  })) as { isError?: boolean };
  expect(empty.isError).toBe(true);
});

it("daemon mode: an inbox change over HTTP notifies the connected MCP client", async () => {
  // One process, both roles: it binds the port AND serves this client's MCP
  // over stdio, which is the only wiring where the notification can exist.
  const dir = await tempProject();
  const { client, stderr } = await connect(dir);
  const port = await waitForPort(stderr);

  const notifications: { method: string; params?: Record<string, unknown> }[] = [];
  client.fallbackNotificationHandler = (notification) => {
    notifications.push(notification as { method: string; params?: Record<string, unknown> });
    return Promise.resolve();
  };

  // `project` travels on the wire so the notification names this exact
  // directory (a spawned process's cwd resolves symlinks; path.resolve does not).
  const created = await fetch(`http://127.0.0.1:${port}/entries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...sampleEntry("http-1", "from the page"), project: dir }),
  });
  expect(created.ok).toBe(true);

  await waitUntil(() => notifications.length >= 1, "the create notification");
  expect(notifications[0]).toMatchObject({ method: "feedback/updated", params: { project: dir } });
  expect(Object.keys(notifications[0]!.params ?? {})).toEqual(["project"]);

  const query = `?project=${encodeURIComponent(dir)}`;
  const deleted = await fetch(`http://127.0.0.1:${port}/entries/http-1${query}`, {
    method: "DELETE",
  });
  expect(deleted.ok).toBe(true);
  await waitUntil(() => notifications.length >= 2, "the delete notification");
  expect(notifications[1]).toMatchObject({ method: "feedback/updated", params: { project: dir } });

  // An unknown id answers `{ok:true}` but changes nothing, so it announces nothing.
  await fetch(`http://127.0.0.1:${port}/entries/never-existed${query}`, { method: "DELETE" });
  await new Promise((done) => setTimeout(done, 150));
  expect(notifications).toHaveLength(2);

  // …and the tools still work over the same connection.
  expect((await callJson(client, "list_feedback", { project: dir })).entries).toEqual([]);
});

/** An MCP client wired to a server in this process — no spawn, no HTTP. */
async function linkedTools(tools: ReviewTools): Promise<Client> {
  const server = createMcpServer(tools, { progressMs: 25 });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "fixui-mcp-test", version: "0.0.0" });
  clients.push(client);
  await client.connect(clientSide);
  return client;
}

async function linked(requestReview: ReviewTools["requestReview"]): Promise<Client> {
  return linkedTools({
    listFeedback: () => Promise.resolve({ entries: [] }),
    resolveFeedback: () => Promise.resolve({ ok: true }),
    listSurfaces: () => Promise.resolve({ surfaces: [] }),
    requestReview,
  });
}

it("reports a busy project as a 'busy' tool error", async () => {
  const client = await linked(() => Promise.reject(new BusyError()));

  const result = (await client.callTool({
    name: "request_review",
    arguments: { prompt: "one too many" },
  })) as { isError?: boolean; content: { text: string }[] };

  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toBe("busy");
});

it("keeps a held request_review alive with progress notifications until it resolves", async () => {
  // The tool holds until this test lets it go.
  let settle!: (outcome: ReviewOutcome) => void;
  const held = new Promise<ReviewOutcome>((resolve) => (settle = resolve));
  const client = await linked(() => held);

  const messages: string[] = [];
  const call = client.callTool({ name: "request_review", arguments: { prompt: "hold me" } }, undefined, {
    onprogress: (progress) => messages.push(String(progress.message)),
  });

  const deadline = Date.now() + 5000;
  while (messages.length < 2 && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 10));
  }
  expect(messages.length).toBeGreaterThanOrEqual(2);
  expect(messages[0]).toMatch(/^waiting for reviewer, \d+s elapsed$/);

  settle({ verdict: "approved", entries: [], durationMs: 42 });
  const result = (await call) as { content: { text: string }[] };
  expect(JSON.parse(result.content[0]!.text)).toEqual({
    verdict: "approved",
    entries: [],
    durationMs: 42,
  });

  // The ticker stops with the call — no interval outlives a resolved review.
  const seen = messages.length;
  await new Promise((done) => setTimeout(done, 100));
  expect(messages.length).toBe(seen);
});

/**
 * The client's own cancellation — `notifications/cancelled`, which is what Esc
 * in Claude Code sends. The review must end there, in BOTH process modes: the
 * agent that asked is gone, nobody will ever read the outcome, and a review
 * left pending wedges the project as `busy` (for `timeoutSeconds` — ten minutes
 * by default) with the page's review banner still up.
 */
const cancelled = /cancel|abort/i;

it("daemon mode: cancelling request_review frees the project and stands the banner down", async () => {
  const dir = await tempProject();
  const broker = createReviewBroker();
  const cancelledEvents: string[] = [];
  const unsubscribe = broker.subscribe(dir, {
    send: (event) => cancelledEvents.push(event),
  });
  const client = await linkedTools(inProcessTools(broker, dir));

  const controller = new AbortController();
  const call = client.callTool(
    { name: "request_review", arguments: { prompt: "look at the hero", timeoutSeconds: 600 } },
    undefined,
    { signal: controller.signal },
  );
  await waitUntil(() => cancelledEvents.includes("review-requested"), "the review to be announced");

  controller.abort();
  await expect(call).rejects.toThrow(cancelled);

  // The page is told, so the banner comes down rather than waiting out 600s.
  await waitUntil(() => cancelledEvents.includes("review-cancelled"), "the page to be told");

  // And the project is free AT ONCE — a `busy` here would be the wedge.
  unsubscribe();
  expect(await callJson(client, "request_review", { prompt: "still working?" })).toEqual({
    verdict: "no-reviewer",
    entries: [],
    durationMs: 0,
  });

  broker.stop();
});

it("proxy mode: cancelling request_review drops the held HTTP call, which frees the daemon", async () => {
  const dir = await tempProject();
  const bridge = createBridgeServer({ port: 0, defaultProject: dir });
  await bridge.start();
  const events: string[] = [];
  const unsubscribe = bridge.broker.subscribe(dir, { send: (event) => events.push(event) });

  try {
    const client = await linkedTools(httpTools(`http://127.0.0.1:${bridge.port}`, dir));

    const controller = new AbortController();
    const call = client.callTool(
      { name: "request_review", arguments: { prompt: "look at the hero", timeoutSeconds: 600 } },
      undefined,
      { signal: controller.signal },
    );
    await waitUntil(() => events.includes("review-requested"), "the review to be announced");

    controller.abort();
    await expect(call).rejects.toThrow(cancelled);
    await waitUntil(() => events.includes("review-cancelled"), "the daemon to end the review");

    unsubscribe();
    expect(await callJson(client, "request_review", { prompt: "still working?" })).toEqual({
      verdict: "no-reviewer",
      entries: [],
      durationMs: 0,
    });
  } finally {
    await bridge.stop();
  }
});

// ── Surfaces (docs/agent-integration.md "Surfaces") ─────────────────────────

/** A page on the review channel: the id the bridge handed it, the events it
 *  saw, and the review it was asked for. */
function fakeSurface(
  broker: ReviewBroker,
  project: string,
  describe: Record<string, unknown>,
): { id(): string; events: string[]; reviewId(): string; close(): void } {
  const events: string[] = [];
  let id = "";
  let reviewId = "";
  const close = broker.subscribe(
    project,
    {
      send: (event, data) => {
        events.push(event);
        if (event === "surface") id = String(data.surfaceId);
        if (event === "review-requested") reviewId = String(data.reviewId);
      },
    },
    describe,
  );
  return { id: () => id, events, reviewId: () => reviewId, close };
}

it("daemon mode: list_surfaces enumerates the connected pages and request_review aims at one", async () => {
  const dir = await tempProject();
  const broker = createReviewBroker();
  const one = fakeSurface(broker, dir, { label: "window one", adapter: "embed" });
  const two = fakeSurface(broker, dir, { label: "window two", adapter: "embed" });
  const client = await linkedTools(inProcessTools(broker, dir));

  try {
    const { surfaces } = await callJson(client, "list_surfaces", {});
    expect(surfaces.map((surface: any) => surface.label)).toEqual(["window two", "window one"]);
    expect(surfaces[0]).toMatchObject({ surfaceId: two.id(), project: dir, adapter: "embed" });

    // Scoped, and scoped away.
    expect((await callJson(client, "list_surfaces", { project: dir })).surfaces).toHaveLength(2);
    const empty = await tempProject();
    expect((await callJson(client, "list_surfaces", { project: empty })).surfaces).toEqual([]);

    const call = client.callTool({
      name: "request_review",
      arguments: { prompt: "look at window two", surfaceId: two.id(), timeoutSeconds: 5 },
    });
    await waitUntil(() => two.events.includes("review-requested"), "the targeted page to be told");
    expect(one.events).toEqual(["surface"]); // and only the targeted page

    // The page answers with the reviewId it was handed.
    await broker.submitVerdict(two.reviewId(), "approved", []);
    expect(JSON.parse(((await call) as any).content[0].text).verdict).toBe("approved");

    // An id nobody is holding is `no-reviewer`, even with two pages connected.
    expect(await callJson(client, "request_review", { prompt: "?", surfaceId: "gone" })).toEqual({
      verdict: "no-reviewer",
      entries: [],
      durationMs: 0,
    });
  } finally {
    one.close();
    two.close();
    broker.stop();
  }
});

it("proxy mode: list_surfaces reads the daemon's surfaces over HTTP, with the daemon's token", async () => {
  const dir = await tempProject();
  const bridge = createBridgeServer({ port: 0, defaultProject: dir, token: "tok-123" });
  await bridge.start();
  const page = fakeSurface(bridge.broker, dir, { label: "the only window", adapter: "extension" });
  const base = `http://127.0.0.1:${bridge.port}`;

  try {
    const client = await linkedTools(httpTools(base, dir, "tok-123"));
    const { surfaces } = await callJson(client, "list_surfaces", {});
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).toMatchObject({
      surfaceId: page.id(),
      project: dir,
      label: "the only window",
      adapter: "extension",
    });

    // The proxy forwards the aim too.
    const call = client.callTool({
      name: "request_review",
      arguments: { prompt: "aimed through the proxy", surfaceId: page.id(), timeoutSeconds: 5 },
    });
    await waitUntil(() => page.events.includes("review-requested"), "the page to be told");
    await bridge.broker.submitVerdict(page.reviewId(), "approved", []);
    expect(JSON.parse(((await call) as any).content[0].text).verdict).toBe("approved");

    // Without the daemon's token the listing is refused — and says so.
    const blind = await linkedTools(httpTools(base, dir));
    const refused = (await blind.callTool({ name: "list_surfaces", arguments: {} })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/token/i);
  } finally {
    page.close();
    await bridge.stop();
  }
});

it("rejects a timeoutSeconds of Infinity, the way the HTTP boundary does", async () => {
  const client = await linked(() =>
    Promise.resolve({ verdict: "approved" as const, entries: [], durationMs: 1 }),
  );

  const result = (await client.callTool({
    name: "request_review",
    arguments: { prompt: "forever?", timeoutSeconds: Number.POSITIVE_INFINITY },
  })) as { isError?: boolean; content: { text: string }[] };

  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain("positive number");
});

it("fails a proxied call when the daemon dies mid-response instead of hanging", async () => {
  // Headers, part of a body, then the daemon goes away. The proxy has no
  // client-side deadline by design, so nothing else would ever settle these.
  // Both deaths matter and they surface differently: a daemon that *exits*
  // sends FIN and the request emits nothing at all — only the response does.
  const stub = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" }); // chunked
    res.write('{"entries":[');
    if (req.url?.includes("reset")) res.socket!.destroy(); // RST
    else setTimeout(() => res.socket!.end(), 20); // FIN, mid-body
  });
  await new Promise<void>((done) => stub.listen(0, "127.0.0.1", done));
  const port = (stub.address() as AddressInfo).port;

  const gone = httpTools(`http://127.0.0.1:${port}`, await tempProject());
  const reset = httpTools(`http://127.0.0.1:${port}/reset`, await tempProject());

  await expect(gone.listFeedback()).rejects.toThrow();
  await expect(gone.requestReview({ prompt: "anyone?" })).rejects.toThrow();
  await expect(reset.listFeedback()).rejects.toThrow();

  await new Promise((done) => stub.close(done));
});

it("proxy mode: a second instance forwards its own project's tools to the running daemon", async () => {
  const daemonDir = await tempProject([sampleEntry("daemon-1", "the daemon's own project")]);
  // A shared `FIXUI_TOKEN` is how a proxy gets the review token it cannot read
  // off the daemon's disk — without it `list_surfaces` is the one tool a proxy
  // cannot serve (the listing is gated).
  const token = "shared-token-for-both";
  const { port, stdout } = await startDaemon(daemonDir, { FIXUI_TOKEN: token });

  const proxyDir = await tempProject([sampleEntry("proxy-1", "the proxy's project")]);
  const { client, stderr } = await connect(proxyDir, ["--port", String(port)], {
    FIXUI_TOKEN: token,
  });

  // The proxy scopes its calls to its own cwd, not the daemon's.
  const listed = await callJson(client, "list_feedback", {});
  expect(listed.entries.map((entry: any) => entry.id)).toEqual(["proxy-1"]);

  expect(await callJson(client, "resolve_feedback", { id: "proxy-1" })).toEqual({ ok: true });
  expect(await inboxIds(proxyDir)).toEqual([]);
  expect(await inboxIds(daemonDir)).toEqual(["daemon-1"]); // untouched

  // The held long-poll travels over HTTP and still answers immediately.
  expect(await callJson(client, "request_review", { prompt: "anyone there?" })).toEqual({
    verdict: "no-reviewer",
    entries: [],
    durationMs: 0,
  });

  // A page connects to the DAEMON, and the proxy can see it — the surface
  // listing crosses the process boundary the same way every other tool does.
  const watcher = new AbortController();
  const query = new URLSearchParams({
    project: daemonDir,
    token,
    label: "the daemon's window",
    adapter: "embed",
  });
  const stream = await fetch(`http://127.0.0.1:${port}/events?${query.toString()}`, {
    signal: watcher.signal,
  });
  expect(stream.status).toBe(200);
  try {
    const { surfaces } = await callJson(client, "list_surfaces", { project: daemonDir });
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).toMatchObject({
      project: daemonDir,
      label: "the daemon's window",
      adapter: "embed",
    });
    expect(typeof surfaces[0].surfaceId).toBe("string");
  } finally {
    watcher.abort();
  }

  expect(stderr()).toContain("proxy");
  expect(stdout()).toBe(""); // stdout belongs to the MCP transport in both modes
});

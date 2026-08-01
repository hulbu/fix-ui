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
import { BusyError, type ReviewOutcome } from "./broker.js";
import { createMcpServer, httpTools, type ReviewTools } from "./mcp.js";
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
async function connect(cwd: string, args: string[] = ["--port", "0"]): Promise<{
  client: Client;
  stderr: () => string;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, ...args],
    cwd,
    stderr: "pipe",
  });
  let stderr = "";
  const client = new Client({ name: "fixui-mcp-test", version: "0.0.0" });
  clients.push(client);
  await client.connect(transport);
  transport.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  return { client, stderr: () => stderr };
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
async function startDaemon(cwd: string): Promise<{ port: number; stdout: () => string }> {
  const child = spawn(process.execPath, [cliPath, "--port", "0"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
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
    "request_review",
    "resolve_feedback",
  ]);
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

/** An MCP client wired to a server in this process — no spawn, no HTTP. */
async function linked(requestReview: ReviewTools["requestReview"]): Promise<Client> {
  const tools: ReviewTools = {
    listFeedback: () => Promise.resolve({ entries: [] }),
    resolveFeedback: () => Promise.resolve({ ok: true }),
    requestReview,
  };
  const server = createMcpServer(tools, { progressMs: 25 });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "fixui-mcp-test", version: "0.0.0" });
  clients.push(client);
  await client.connect(clientSide);
  return client;
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
  const { port, stdout } = await startDaemon(daemonDir);

  const proxyDir = await tempProject([sampleEntry("proxy-1", "the proxy's project")]);
  const { client, stderr } = await connect(proxyDir, ["--port", String(port)]);

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

  expect(stderr()).toContain("proxy");
  expect(stdout()).toBe(""); // stdout belongs to the MCP transport in both modes
});

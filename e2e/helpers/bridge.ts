import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A real `fixui-bridge` per test: the built `packages/bridge/dist/cli.js`,
 * spawned on an ephemeral port with a throwaway directory as its project.
 *
 * **Port discovery.** `--port 0` lets the OS pick, and the CLI logs the bound
 * port (`fixui-bridge listening on http://127.0.0.1:<port>`) — on **stderr**,
 * because a process handed a pipe on stdin assumes a harness is speaking MCP on
 * stdout. So: read the port off stderr, then confirm it with `/healthz` before
 * handing it to a test. (Binding a port here to "reserve" it and releasing it
 * again would be the racy alternative; the daemon's own log is authoritative.)
 *
 * The spawned process therefore also has an MCP server wired to its stdio. No
 * client ever initializes it, so it stays silent — see the `initialized` gate
 * in packages/bridge/src/mcp.ts.
 */
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = path.join(repoRoot, "packages", "bridge", "dist", "cli.js");

const PORT_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 5000;

export type JsonRecord = Record<string, unknown>;

export interface Bridge {
  /** e.g. "http://127.0.0.1:53211" */
  readonly url: string;
  readonly port: number;
  /** The temp directory the daemon runs in — its inbox lives here. */
  readonly project: string;
  /** `.fix-ui.jsonl`, parsed. Empty until the first entry lands. */
  entries(): Promise<JsonRecord[]>;
  /** `.fix-ui.reviews.jsonl`, parsed. */
  reviews(): Promise<JsonRecord[]>;
  stop(): Promise<void>;
}

async function readJsonl(file: string): Promise<JsonRecord[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return []; // never written yet
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JsonRecord);
}

async function healthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
    return res.ok && ((await res.json()) as { name?: string }).name === "fixui-bridge";
  } catch {
    return false;
  }
}

export async function startBridge(): Promise<Bridge> {
  const project = await mkdtemp(path.join(tmpdir(), "fixui-e2e-"));
  const child: ChildProcess = spawn(process.execPath, [cliPath, "--port", "0"], {
    cwd: project,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  let stdout = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));

  let exited = false;
  child.on("exit", () => (exited = true));

  const stop = async (): Promise<void> => {
    if (!exited) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((done) => child.once("exit", done)),
        new Promise((done) => setTimeout(done, EXIT_TIMEOUT_MS)).then(() => child.kill("SIGKILL")),
      ]);
    }
    await rm(project, { recursive: true, force: true });
  };

  const deadline = Date.now() + PORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      await stop();
      throw new Error(`fixui-bridge exited before binding a port\nstderr: ${stderr}`);
    }
    const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stderr);
    if (match && (await healthy(match[1]!))) {
      const url = match[1]!;
      return {
        url,
        port: Number(new URL(url).port),
        project,
        entries: () => readJsonl(path.join(project, ".fix-ui.jsonl")),
        reviews: () => readJsonl(path.join(project, ".fix-ui.reviews.jsonl")),
        stop,
      };
    }
    await new Promise((done) => setTimeout(done, 25));
  }

  await stop();
  throw new Error(
    `fixui-bridge never reported a healthy port within ${PORT_TIMEOUT_MS}ms\n` +
      `stderr: ${stderr}\nstdout: ${stdout}`,
  );
}

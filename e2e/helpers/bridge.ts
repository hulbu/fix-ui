import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A real bridge per test, started the way a developer starts one: the built
 * `packages/bridge/dist/cli.js` as `fixui dev -- <a process that just waits>`,
 * with a throwaway directory as its project. The bridge's lifetime belongs to
 * that dev command, so `stop()` is a signal to the wrapper and everything —
 * port, discovery file, child — goes away together.
 *
 * **Discovery.** No fixed port and no fixed token: the bridge binds 0 and
 * publishes both in `.fix-ui.json` in its project, which is where adapters and
 * the agent's MCP proxy read them, so it is where this helper reads them too.
 * (Binding a port here to "reserve" one and releasing it again would be the
 * racy alternative; the bridge's own file is authoritative.) `/healthz`
 * confirms the port before any test is handed it.
 */
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = path.join(repoRoot, "packages", "bridge", "dist", "cli.js");

/** A stand-in for a dev server: a process that ends only when it is signalled. */
const DEV_COMMAND = [process.execPath, "-e", "setInterval(() => {}, 1 << 30)"];

const START_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 5000;

export type JsonRecord = Record<string, unknown>;

export interface Bridge {
  /** e.g. "http://127.0.0.1:53211" */
  readonly url: string;
  readonly port: number;
  /** The temp directory the bridge runs in — its inbox lives here. */
  readonly project: string;
  /**
   * The review channel's token, from `.fix-ui.json`. Adapters get it from that
   * file too; without it `GET /events` and the verdict POST are 401.
   */
  readonly token: string;
  /** `.fix-ui.jsonl`, parsed. Empty until the first entry lands. */
  entries(): Promise<JsonRecord[]>;
  /** `.fix-ui.reviews.jsonl`, parsed. */
  reviews(): Promise<JsonRecord[]>;
  stop(): Promise<void>;
}

interface Discovery {
  v: 1;
  port: number;
  token: string;
  pid: number;
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

async function readDiscovery(project: string): Promise<Discovery | undefined> {
  try {
    return JSON.parse(await readFile(path.join(project, ".fix-ui.json"), "utf8")) as Discovery;
  } catch {
    return undefined; // not published yet, or half a write
  }
}

export async function startBridge(): Promise<Bridge> {
  const project = await mkdtemp(path.join(tmpdir(), "fixui-e2e-"));
  const child: ChildProcess = spawn(process.execPath, [cliPath, "dev", "--", ...DEV_COMMAND], {
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
      // The wrapper passes this on to the dev command and takes the bridge down
      // when it goes; SIGKILL is the last resort for a child that will not.
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((done) => child.once("exit", done)),
        new Promise((done) => setTimeout(done, EXIT_TIMEOUT_MS)).then(() => child.kill("SIGKILL")),
      ]);
    }
    await rm(project, { recursive: true, force: true });
  };

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      await stop();
      throw new Error(`fixui dev exited before publishing a bridge\nstderr: ${stderr}`);
    }
    const discovery = await readDiscovery(project);
    const url = discovery === undefined ? undefined : `http://127.0.0.1:${discovery.port}`;
    if (url !== undefined && discovery !== undefined && (await healthy(url))) {
      return {
        url,
        port: discovery.port,
        project,
        token: discovery.token,
        entries: () => readJsonl(path.join(project, ".fix-ui.jsonl")),
        reviews: () => readJsonl(path.join(project, ".fix-ui.reviews.jsonl")),
        stop,
      };
    }
    await new Promise((done) => setTimeout(done, 25));
  }

  await stop();
  throw new Error(
    `fixui dev never published a healthy bridge within ${START_TIMEOUT_MS}ms\n` +
      `stderr: ${stderr}\nstdout: ${stdout}`,
  );
}

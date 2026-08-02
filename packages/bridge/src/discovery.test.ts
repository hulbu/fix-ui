/**
 * The discovery file — `.fix-ui.json`, how everything that is not the owner
 * finds the owner. Read by adapters in the page and by the agent's proxy, so
 * "missing" and "garbage" and "names a port nobody answers" all have to be the
 * same answer: there is no bridge.
 */
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  DISCOVERY_FILE,
  liveBridge,
  readDiscovery,
  removeDiscovery,
  writeDiscovery,
} from "./discovery.js";
import { createBridgeServer } from "./server.js";

const tempDirs: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "fixui-discovery-"));
  tempDirs.push(dir);
  return dir;
}

/** A port that was bound and released: nothing answers there now. */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

it("round-trips the discovery file at 0600, even over a world-readable one", async () => {
  const dir = await tempProject();
  const file = path.join(dir, DISCOVERY_FILE);
  // A leftover from a previous run, with the wrong permissions.
  await writeFile(file, "stale", { mode: 0o644 });

  await writeDiscovery(dir, { v: 1, port: 51234, token: "s3cret", pid: 4242 });

  expect(await readDiscovery(dir)).toEqual({ v: 1, port: 51234, token: "s3cret", pid: 4242 });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  // Plain JSON on disk: adapters in other languages read this file too.
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ v: 1, port: 51234 });
});

it("reads a missing, malformed or wrong-shaped file as no discovery at all", async () => {
  const dir = await tempProject();
  expect(await readDiscovery(dir)).toBeUndefined();

  const file = path.join(dir, DISCOVERY_FILE);
  const rejected = [
    "not json at all",
    "[]",
    "null",
    JSON.stringify({ v: 2, port: 1, token: "t", pid: 1 }),
    JSON.stringify({ v: 1, token: "t", pid: 1 }),
    JSON.stringify({ v: 1, port: 0, token: "t", pid: 1 }),
    JSON.stringify({ v: 1, port: 70000, token: "t", pid: 1 }),
    JSON.stringify({ v: 1, port: 3000, token: "", pid: 1 }),
    JSON.stringify({ v: 1, port: 3000, token: "t" }),
  ];
  for (const raw of rejected) {
    await writeFile(file, raw);
    expect(await readDiscovery(dir), raw).toBeUndefined();
  }
});

it("removes the discovery file, and says nothing when there is none", async () => {
  const dir = await tempProject();
  await removeDiscovery(dir); // no file: not an error

  await writeDiscovery(dir, { v: 1, port: 4001, token: "t", pid: 1 });
  await removeDiscovery(dir);
  expect(await readDiscovery(dir)).toBeUndefined();
});

it("calls a port live only when a fixui-bridge answers there", async () => {
  const bridge = createBridgeServer({ port: 0, defaultProject: await tempProject() });
  await bridge.start();
  closers.push(() => bridge.stop());

  expect(await liveBridge(bridge.port)).toBe(true);

  // A stranger on the port is not our bridge, and neither is silence.
  const stranger = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "something-else" }));
  });
  await new Promise<void>((done) => stranger.listen(0, "127.0.0.1", done));
  closers.push(() => new Promise((done) => stranger.close(() => done())));
  expect(await liveBridge((stranger.address() as AddressInfo).port)).toBe(false);

  expect(await liveBridge(await deadPort())).toBe(false);
  expect(await liveBridge(0)).toBe(false);
});

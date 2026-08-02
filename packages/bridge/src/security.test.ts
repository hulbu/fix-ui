/**
 * The attacks the bridge's HTTP surface has to survive, written as tests.
 *
 * The premise (docs/design.md "Security", docs/agent-integration.md "Privacy"):
 * while this daemon runs, EVERY page the developer visits can talk to it. CORS
 * cannot be the defence — the embed exists to run on whatever origin the app
 * uses. So each test below is a hostile page's move, and the assertion is what
 * the daemon does about it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MAX_BODY_BYTES, MAX_NOTE, MAX_SELECTOR, createBridgeServer, type BridgeServer } from "./server.js";

const TOKEN = "test-token-abc123";
const JSON_HEADERS = { "content-type": "application/json" };

let server: BridgeServer;
let projectDir: string;
let base: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "fixui-security-"));
  server = createBridgeServer({ port: 0, defaultProject: projectDir, token: TOKEN, heartbeatMs: 40 });
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.stop();
  await rm(projectDir, { recursive: true, force: true });
});

/** The JSON every route answers with; typed loosely, the way a caller reads it. */
async function body(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

function sampleEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: "e1",
    note: "make this button bigger",
    selector: "#cta",
    url: "http://localhost:4001/",
    viewport: { width: 800, height: 600 },
    userAgent: "test-agent",
    createdAt: "2026-07-31T09:00:00.000Z",
    ...over,
  };
}

/** Raw HTTP, so the `Host` header and an oversized body are ours to choose. */
function raw(
  method: string,
  rawPath: string,
  options: { host?: string; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...JSON_HEADERS };
    if (options.host !== undefined) headers.host = options.host;
    if (options.body !== undefined) headers["content-length"] = String(Buffer.byteLength(options.body));
    const req = request(
      { host: "127.0.0.1", port: server.port, method, path: rawPath, headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("no response")));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/**
 * DNS rebinding: `evil.com` resolves to 127.0.0.1, so the browser dials the
 * daemon believing it is talking to evil.com — same origin, every CORS decision
 * moot, `GET /entries` readable. The browser always sends the name it dialed,
 * and that is what gives the game away.
 */
it("refuses a request whose Host is not loopback (DNS rebinding)", async () => {
  const rebound = await raw("GET", "/entries", { host: "evil.example.com" });
  expect(rebound.status).toBe(403);
  expect(JSON.parse(rebound.body).ok).toBe(false);

  // Same name on the right port is still the wrong name.
  expect((await raw("GET", "/entries", { host: `evil.example.com:${server.port}` })).status).toBe(403);
  // A LAN address the daemon never bound is the same story from the other side.
  expect((await raw("GET", "/healthz", { host: `192.168.1.5:${server.port}` })).status).toBe(403);
  // And loopback on a port this daemon does not own is not this daemon.
  expect((await raw("GET", "/healthz", { host: "127.0.0.1:1" })).status).toBe(403);

  // Both loopback spellings keep working.
  expect((await raw("GET", "/healthz", { host: `127.0.0.1:${server.port}` })).status).toBe(200);
  expect((await raw("GET", "/healthz", { host: `localhost:${server.port}` })).status).toBe(200);
});

it("caps the request body at 256KB instead of buffering whatever it is sent", async () => {
  const huge = JSON.stringify(sampleEntry({ note: "x".repeat(MAX_BODY_BYTES) }));
  expect(huge.length).toBeGreaterThan(MAX_BODY_BYTES);

  const res = await raw("POST", "/entries", { body: huge });
  expect(res.status).toBe(413);
  expect(JSON.parse(res.body).ok).toBe(false);

  // The daemon is still serving — a refused body is not a crash.
  expect((await fetch(`${base}/healthz`)).status).toBe(200);
});

it("caps note and selector at the boundary", async () => {
  const longNote = await fetch(`${base}/entries`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(sampleEntry({ note: "x".repeat(MAX_NOTE + 1) })),
  });
  expect(longNote.status).toBe(400);
  expect((await body(longNote)).error).toContain("note");

  const longSelector = await fetch(`${base}/entries`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(sampleEntry({ selector: "d".repeat(MAX_SELECTOR + 1) })),
  });
  expect(longSelector.status).toBe(400);

  // Right at the cap is still a note.
  const atCap = await fetch(`${base}/entries`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(sampleEntry({ note: "x".repeat(MAX_NOTE) })),
  });
  expect(atCap.status).toBe(200);
});

/**
 * The review channel is the human-in-the-loop guarantee. Subscribing is how a
 * page learns a reviewId, and a reviewId is all it takes to answer the review
 * in the developer's place — so both halves are gated.
 */
it("refuses the review channel without the token", async () => {
  const stream = await fetch(`${base}/events`);
  expect(stream.status).toBe(401);
  await stream.body?.cancel();

  const wrongToken = await fetch(`${base}/events?token=guess`);
  expect(wrongToken.status).toBe(401);
  await wrongToken.body?.cancel();

  const verdict = await fetch(`${base}/reviews/rev-1/verdict`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ verdict: "approved", entryIds: [] }),
  });
  expect(verdict.status).toBe(401);
  expect((await body(verdict)).error).toContain("token");
});

/** The surface listing says what the developer has open — which page, which
 *  window, which site. That is disclosure, so it lives behind the same gate as
 *  the stream it describes. */
it("refuses the surface listing without the token", async () => {
  const listed = await fetch(`${base}/surfaces`);
  expect(listed.status).toBe(401);
  expect((await body(listed)).error).toContain("token");

  const wrong = await fetch(`${base}/surfaces?token=guess`);
  expect(wrong.status).toBe(401);

  const allowed = await fetch(`${base}/surfaces?token=${TOKEN}`);
  expect(allowed.status).toBe(200);
  expect(await body(allowed)).toEqual({ surfaces: [] });
});

it("accepts the token in the query string or in the header", async () => {
  const controller = new AbortController();
  const stream = await fetch(`${base}/events?token=${TOKEN}`, { signal: controller.signal });
  expect(stream.status).toBe(200);
  expect(stream.headers.get("content-type")).toContain("text/event-stream");
  controller.abort();

  const byHeader = new AbortController();
  const headerStream = await fetch(`${base}/events`, {
    headers: { "x-fixui-token": TOKEN },
    signal: byHeader.signal,
  });
  expect(headerStream.status).toBe(200);
  byHeader.abort();

  // Past the gate, an unknown review is a 404 — not a 401.
  const verdict = await fetch(`${base}/reviews/rev-1/verdict?token=${TOKEN}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ verdict: "approved", entryIds: [] }),
  });
  expect(verdict.status).toBe(404);
});

/** The entries side stays open on purpose (the embed runs on any dev origin);
 *  the caps above are what carries that, so the CORS promise must not drift. */
it("keeps the entries routes reachable cross-origin", async () => {
  const res = await fetch(`${base}/entries`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(sampleEntry()),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
});

it("no configured token leaves the review channel open — which is a test-only shape", async () => {
  const open = createBridgeServer({ port: 0, defaultProject: projectDir });
  await open.start();
  try {
    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${open.port}/events`, { signal: controller.signal });
    expect(stream.status).toBe(200);
    controller.abort();
  } finally {
    await open.stop();
  }
});

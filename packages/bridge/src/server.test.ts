import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createBridgeServer, type BridgeServer } from "./server.js";
import { inboxPath } from "./storage.js";

let server: BridgeServer;
let projectDir: string;
let otherDir: string;
let base: string;

const JSON_HEADERS = { "content-type": "application/json" };

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "fixui-server-"));
  otherDir = await mkdtemp(path.join(tmpdir(), "fixui-other-"));
  // Port 0: the OS picks a free port, so tests never touch the daemon's 3499.
  server = createBridgeServer({ port: 0, defaultProject: projectDir });
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.stop();
  await rm(projectDir, { recursive: true, force: true });
  await rm(otherDir, { recursive: true, force: true });
});

function sampleEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: "e1",
    note: "make this button bigger",
    selector: "#pricing button.mt-5",
    url: "http://localhost:4001/#pricing",
    viewport: { width: 1579, height: 933 },
    userAgent: "test-agent",
    createdAt: "2026-07-31T09:00:00.000Z",
    ...over,
  };
}

function post(entry: unknown, url = `${base}/entries`): Promise<Response> {
  return fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(entry) });
}

async function body(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

/** Raw HTTP — for paths fetch() would normalize or refuse to send. */
function rawRequest(method: string, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, method, path: rawPath }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("no response to a malformed path")));
    req.end();
  });
}

async function storedLines(dir: string): Promise<Record<string, any>[]> {
  const raw = await readFile(inboxPath(dir), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

it("POST /entries appends a JSONL line to <project>/.fix-ui.jsonl, strips wire-only project, preserves unknown fields, returns {ok:true,entry}", async () => {
  const res = await post(
    sampleEntry({ project: projectDir, component: "WaitlistModal", futureField: { nested: [1] } }),
  );

  expect(res.status).toBe(200);
  const payload = await body(res);
  expect(payload.ok).toBe(true);
  expect(payload.entry.project).toBeUndefined();
  expect(payload.entry.futureField).toEqual({ nested: [1] });
  expect(payload.entry.component).toBe("WaitlistModal");

  const raw = await readFile(inboxPath(projectDir), "utf8");
  expect(raw.endsWith("\n")).toBe(true);
  const lines = raw.split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  // What went to disk is exactly what came back.
  expect(JSON.parse(lines[0]!)).toEqual(payload.entry);
  expect(JSON.parse(lines[0]!)).toEqual({
    v: 1,
    id: "e1",
    note: "make this button bigger",
    selector: "#pricing button.mt-5",
    url: "http://localhost:4001/#pricing",
    viewport: { width: 1579, height: 933 },
    userAgent: "test-agent",
    createdAt: "2026-07-31T09:00:00.000Z",
    component: "WaitlistModal",
    futureField: { nested: [1] },
  });
});

it("POST /entries with project routing writes to that directory; invalid project dir → 400", async () => {
  const routed = await post(sampleEntry({ project: otherDir }));
  expect(routed.status).toBe(200);

  expect((await storedLines(otherDir)).map((e) => e.id)).toEqual(["e1"]);
  await expect(readFile(inboxPath(projectDir), "utf8")).rejects.toThrow();

  for (const project of ["packages/bridge", path.join(otherDir, "missing"), 42]) {
    const res = await post(sampleEntry({ project }));
    expect(res.status).toBe(400);
    expect((await body(res)).ok).toBe(false);
  }
});

it("GET /entries returns {entries:[…]} for the resolved project", async () => {
  expect(await body(await fetch(`${base}/entries`))).toEqual({ entries: [] });

  await post(sampleEntry({ id: "default-1" }));
  await post(sampleEntry({ id: "other-1", project: otherDir }));

  expect((await body(await fetch(`${base}/entries`))).entries.map((e: any) => e.id)).toEqual([
    "default-1",
  ]);
  const routed = await body(
    await fetch(`${base}/entries?project=${encodeURIComponent(otherDir)}`),
  );
  expect(routed.entries.map((e: any) => e.id)).toEqual(["other-1"]);

  const invalid = await fetch(`${base}/entries?project=not-absolute`);
  expect(invalid.status).toBe(400);
  expect((await body(invalid)).ok).toBe(false);
});

it("DELETE /entries/:id and body-style DELETE /entries {id} both remove the line", async () => {
  await post(sampleEntry({ id: "a" }));
  await post(sampleEntry({ id: "b" }));

  const byPath = await fetch(`${base}/entries/a`, { method: "DELETE" });
  expect(byPath.status).toBe(200);
  expect((await body(byPath)).ok).toBe(true);
  expect((await storedLines(projectDir)).map((e) => e.id)).toEqual(["b"]);

  const byBody = await fetch(`${base}/entries`, {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: JSON.stringify({ id: "b" }),
  });
  expect(byBody.status).toBe(200);
  expect((await body(byBody)).ok).toBe(true);
  expect(await readFile(inboxPath(projectDir), "utf8")).toBe("");

  // Body-style delete without an id is a client error, not a silent no-op.
  const noId = await fetch(`${base}/entries`, {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: JSON.stringify({}),
  });
  expect(noId.status).toBe(400);
  expect((await body(noId)).ok).toBe(false);

  // Project routing applies to deletes too.
  await post(sampleEntry({ id: "other-1", project: otherDir }));
  const routed = await fetch(`${base}/entries/other-1?project=${encodeURIComponent(otherDir)}`, {
    method: "DELETE",
  });
  expect(routed.status).toBe(200);
  expect(await readFile(inboxPath(otherDir), "utf8")).toBe("");
});

it("body-style DELETE routes on the body's project", async () => {
  await post(sampleEntry({ id: "keep" }));
  await post(sampleEntry({ id: "gone", project: otherDir }));

  const res = await fetch(`${base}/entries`, {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: JSON.stringify({ id: "gone", project: otherDir }),
  });

  expect(res.status).toBe(200);
  expect(await readFile(inboxPath(otherDir), "utf8")).toBe("");
  expect((await storedLines(projectDir)).map((e) => e.id)).toEqual(["keep"]); // untouched

  const invalid = await fetch(`${base}/entries`, {
    method: "DELETE",
    headers: JSON_HEADERS,
    body: JSON.stringify({ id: "keep", project: "relative/path" }),
  });
  expect(invalid.status).toBe(400);
  expect((await storedLines(projectDir)).map((e) => e.id)).toEqual(["keep"]);
});

it("serializes concurrent writes to one inbox", async () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  for (const id of ids) await post(sampleEntry({ id }));

  const deletes = await Promise.all(
    ["a", "b", "c"].map((id) => fetch(`${base}/entries/${id}`, { method: "DELETE" })),
  );

  for (const res of deletes) expect(res.status).toBe(200);
  expect((await storedLines(projectDir)).map((e) => e.id)).toEqual(["d", "e", "f"]);

  // A create racing a delete: neither may lose the other's work.
  for (let round = 0; round < 10; round++) {
    const victim = `victim-${round}`;
    const fresh = `fresh-${round}`;
    await post(sampleEntry({ id: victim }));

    await Promise.all([
      post(sampleEntry({ id: fresh })),
      fetch(`${base}/entries/${victim}`, { method: "DELETE" }),
    ]);

    const stored = (await storedLines(projectDir)).map((e) => e.id);
    expect(stored).toContain(fresh);
    expect(stored).not.toContain(victim);
  }
});

it("rejects entries without note/selector with 400 {ok:false}", async () => {
  const bad: unknown[] = [
    sampleEntry({ note: undefined }),
    sampleEntry({ selector: undefined }),
    sampleEntry({ note: "   " }),
    sampleEntry({ selector: 5 }),
    "just a string",
    null,
    [1, 2, 3],
  ];

  for (const payload of bad) {
    const res = await post(payload);
    expect(res.status).toBe(400);
    const parsed = await body(res);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
  }

  const malformed = await fetch(`${base}/entries`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: "{not json",
  });
  expect(malformed.status).toBe(400);
  expect((await body(malformed)).ok).toBe(false);

  // Nothing rejected reaches the inbox.
  await expect(readFile(inboxPath(projectDir), "utf8")).rejects.toThrow();
});

it("returns 500 with the attempted path when the inbox is unwritable", async () => {
  // A directory where the inbox file belongs: unwritable on every platform.
  await mkdir(inboxPath(projectDir));

  const res = await post(sampleEntry());
  expect(res.status).toBe(500);
  const payload = await body(res);
  expect(payload.ok).toBe(false);
  expect(payload.error).toContain(inboxPath(projectDir));

  const listed = await fetch(`${base}/entries`);
  expect(listed.status).toBe(500);
  expect((await body(listed)).error).toContain(inboxPath(projectDir));
});

it("GET /healthz → {ok:true,name:'fixui-bridge',version}; OPTIONS preflight returns CORS headers", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };

  const res = await fetch(`${base}/healthz`);
  expect(res.status).toBe(200);
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(await body(res)).toEqual({ ok: true, name: "fixui-bridge", version: pkg.version });

  const preflight = await fetch(`${base}/entries`, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:4001",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  expect(preflight.status).toBeLessThan(300);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  const methods = preflight.headers.get("access-control-allow-methods") ?? "";
  expect(methods).toContain("GET");
  expect(methods).toContain("POST");
  expect(methods).toContain("DELETE");
  expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
    "content-type",
  );

  // CORS is on every route, not just the preflight.
  expect(
    (await fetch(`${base}/entries`)).headers.get("access-control-allow-origin"),
  ).toBe("*");
});

it("answers unknown paths with 404 JSON", async () => {
  const res = await fetch(`${base}/nope`);

  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  const payload = await body(res);
  expect(payload.ok).toBe(false);
  expect(typeof payload.error).toBe("string");
});

it("answers a malformed request path instead of dropping the connection", async () => {
  // fetch() normalizes the path away, so this one goes out raw: an undecodable
  // escape must not leave the request hanging (and the daemon dead) — it is
  // just an id that matches nothing.
  const res = await rawRequest("DELETE", "/entries/%zz");

  expect(res.status).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ ok: true });
  expect((await fetch(`${base}/healthz`)).status).toBe(200); // still serving
});

it("lets later features register routes that reach the server's shared state", async () => {
  // Task 5 registers /events and /reviews/:id/verdict this way.
  server.route("POST", "/reviews/:reviewId/verdict", (ctx) => {
    ctx.json(200, {
      ok: true,
      reviewId: ctx.params.reviewId,
      project: ctx.url.searchParams.get("project") ?? ctx.server.defaultProject,
    });
  });

  const res = await fetch(`${base}/reviews/r1/verdict`, { method: "POST" });

  expect(res.status).toBe(200);
  expect(await body(res)).toEqual({ ok: true, reviewId: "r1", project: projectDir });
});

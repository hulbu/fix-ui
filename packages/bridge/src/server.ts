/**
 * The bridge's HTTP surface: `POST /entries`, `GET /entries`, `DELETE
 * /entries/:id` (plus the prototype's body-style `DELETE /entries {id}`, so one
 * transport client works bridge-less against an app-provided endpoint),
 * `GET /healthz`, and the review channel — `GET /events` (SSE to adapters),
 * `POST /reviews` (the agent's held call) and `POST /reviews/:id/verdict`.
 *
 * Loopback only — this is a local dev daemon, never a network service. CORS is
 * wide open because the callers are whatever origin the developer's app runs on.
 *
 * Routes live in a table so later features can register their own and reach
 * shared state through `ctx.server`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BusyError,
  createReviewBroker,
  DEFAULT_TIMEOUT_SECONDS,
  type ReviewBroker,
  type ReviewOutcome,
} from "./broker.js";
import {
  appendEntry,
  listEntries,
  removeEntry,
  resolveProject,
  type JsonRecord,
} from "./storage.js";
import { packageVersion } from "./version.js";

export const HOST = "127.0.0.1";

/** Comment-line keep-alive for SSE (docs/agent-integration.md): intermediaries
 *  and idle-socket timers must not decide a quiet review is a dead stream. */
const HEARTBEAT_MS = 15_000;

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
};

export interface BridgeServerOptions {
  /** 0 lets the OS pick a free port; the bound port lands on `server.port`. */
  port: number;
  /** Where entries go when the wire carries no `project` — the daemon's cwd. */
  defaultProject: string;
  /** SSE keep-alive spacing; only tests have a reason to shorten it. */
  heartbeatMs?: number;
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  server: BridgeServer;
  json(status: number, payload: unknown): void;
}

export type RouteHandler = (ctx: RouteContext) => void | Promise<void>;

export interface BridgeServer {
  /** The bound port once started (the requested one until then). */
  readonly port: number;
  readonly defaultProject: string;
  /** One broker per daemon — the MCP server calls it in-process. */
  readonly broker: ReviewBroker;
  /** Register a route; `:name` segments become `ctx.params.name`. */
  route(method: string, pattern: string, handler: RouteHandler): void;
  /**
   * Watch inbox mutations; the listener gets the resolved project directory,
   * and the returned function stops watching. Fire-and-forget by contract: a
   * listener that throws or blocks may not affect the HTTP request that caused
   * the change (daemon mode turns this into an MCP `feedback/updated`
   * notification — docs/agent-integration.md).
   */
  onInboxChange(listener: (project: string) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...CORS_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Read a JSON object body. `null` means "not a JSON object" — malformed,
 *  a scalar, an array or empty — which is always a 400 at this boundary. */
export async function readJsonRecord(req: IncomingMessage): Promise<JsonRecord | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as JsonRecord;
}

function isFilledString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value; // an undecodable escape is just an id that matches nothing
  }
}

function matchRoute(route: Route, segments: string[]): Record<string, string> | null {
  if (route.segments.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [index, expected] of route.segments.entries()) {
    const actual = segments[index]!;
    if (!expected.startsWith(":")) {
      if (expected !== actual) return null;
      continue;
    }
    if (actual === "") return null;
    params[expected.slice(1)] = decodeSegment(actual);
  }
  return params;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Answer a failed request. Inbox failures land here: the message names the
 *  path the bridge tried (docs/design.md "Error handling"). */
function fail(res: ServerResponse, cause: unknown): void {
  if (res.headersSent) res.end();
  else sendJson(res, 500, { ok: false, error: errorText(cause) });
}

const INVALID_PROJECT = "project must be an absolute path to an existing directory";

export function createBridgeServer(opts: BridgeServerOptions): BridgeServer {
  const routes: Route[] = [];
  const broker = createReviewBroker();
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const inboxListeners = new Set<(project: string) => void>();
  let boundPort = opts.port;
  let http: Server | undefined;

  /** Tell the watchers the inbox changed. Never on the request's critical path:
   *  a broken listener is the listener's problem, not the writer's. */
  function inboxChanged(project: string): void {
    for (const listener of [...inboxListeners]) {
      try {
        listener(project);
      } catch {
        // Nothing to do — the entry is already on disk and answered.
      }
    }
  }

  const api: BridgeServer = {
    get port() {
      return boundPort;
    },
    defaultProject: opts.defaultProject,
    broker,

    route(method, pattern, handler) {
      routes.push({ method, segments: normalizePath(pattern).split("/"), handler });
    },

    onInboxChange(listener) {
      inboxListeners.add(listener);
      return () => {
        inboxListeners.delete(listener);
      };
    },

    start() {
      return new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
          // Nothing a request can do may take the daemon down or leave the
          // connection hanging — always answer, even on our own bugs.
          dispatch(req, res).catch((cause: unknown) => fail(res, cause));
        });
        const onError = (cause: Error): void => reject(cause);
        server.once("error", onError);
        server.listen(opts.port, HOST, () => {
          server.removeListener("error", onError);
          boundPort = (server.address() as AddressInfo).port;
          http = server;
          resolve();
        });
      });
    },

    stop() {
      broker.stop(); // held reviews and their timers die with the daemon
      const server = http;
      if (!server) return Promise.resolve();
      http = undefined;
      return new Promise((resolve, reject) => {
        server.closeAllConnections(); // keep-alive sockets would hold close() open
        server.close((cause) => (cause ? reject(cause) : resolve()));
      });
    },
  };

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${HOST}:${boundPort}`);
    if (req.method === "OPTIONS") {
      // Preflight for every route, including the ones registered later.
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    const segments = normalizePath(url.pathname).split("/");
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const params = matchRoute(route, segments);
      if (!params) continue;
      const ctx: RouteContext = {
        req,
        res,
        url,
        params,
        server: api,
        json: (status, payload) => sendJson(res, status, payload),
      };
      try {
        await route.handler(ctx);
      } catch (cause) {
        fail(res, cause);
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: `no route for ${req.method} ${url.pathname}` });
  }

  /** Query-string project routing for the read/delete side. */
  function projectFromQuery(ctx: RouteContext): string | null {
    return resolveProject(ctx.url.searchParams.get("project"), api.defaultProject);
  }

  api.route("POST", "/entries", async (ctx) => {
    const entry = await readJsonRecord(ctx.req);
    if (!entry) return ctx.json(400, { ok: false, error: "expected a JSON object body" });
    if (!isFilledString(entry.note) || !isFilledString(entry.selector)) {
      return ctx.json(400, { ok: false, error: "entry requires a non-empty note and selector" });
    }

    const project = resolveProject(entry.project, api.defaultProject);
    if (!project) return ctx.json(400, { ok: false, error: INVALID_PROJECT });

    ctx.json(200, { ok: true, entry: await appendEntry(project, entry) });
    inboxChanged(project);
  });

  api.route("GET", "/entries", async (ctx) => {
    const project = projectFromQuery(ctx);
    if (!project) return ctx.json(400, { ok: false, error: INVALID_PROJECT });

    ctx.json(200, { entries: await listEntries(project) });
  });

  api.route("DELETE", "/entries/:id", async (ctx) => {
    const project = projectFromQuery(ctx);
    if (!project) return ctx.json(400, { ok: false, error: INVALID_PROJECT });

    const removed = await removeEntry(project, ctx.params.id!);
    ctx.json(200, { ok: true });
    // Only a real removal is a change: `{ok:true}` also answers an unknown id,
    // and announcing that would make `feedback/updated` mean nothing.
    if (removed) inboxChanged(project);
  });

  // The prototype's body-style delete, kept so one transport client serves both.
  api.route("DELETE", "/entries", async (ctx) => {
    const body = await readJsonRecord(ctx.req);
    const id = body?.id;
    if (!body || (typeof id !== "string" && typeof id !== "number")) {
      return ctx.json(400, { ok: false, error: "delete requires an id" });
    }

    // The client carries `project` in the body here, the way it does on create;
    // the query string is the fallback so curl-style deletes work too.
    const requested = body.project ?? ctx.url.searchParams.get("project");
    const project = resolveProject(requested, api.defaultProject);
    if (!project) return ctx.json(400, { ok: false, error: INVALID_PROJECT });

    const removed = await removeEntry(project, String(id));
    ctx.json(200, { ok: true });
    if (removed) inboxChanged(project);
  });

  // ── The review channel (docs/agent-integration.md "Direction 2") ──────────

  /** The adapter's half: one long-lived SSE stream per page. */
  api.route("GET", "/events", (ctx) => {
    const project = projectFromQuery(ctx);
    if (!project) return ctx.json(400, { ok: false, error: INVALID_PROJECT });

    const write = (chunk: string): void => {
      if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.res.write(chunk);
    };

    ctx.res.writeHead(200, {
      ...CORS_HEADERS,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    // A comment right away flushes the headers, so the page knows it is on.
    write(": connected\n\n");

    const heartbeat = setInterval(() => write(": heartbeat\n\n"), heartbeatMs);
    const unsubscribe = broker.subscribe(project, {
      send: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    });
    ctx.res.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    // No `end()`: the stream stays open until the page goes away.
  });

  /** The agent's half: held open, answered only when the review resolves. */
  api.route("POST", "/reviews", async (ctx) => {
    const body = await readJsonRecord(ctx.req);
    if (!body) return ctx.json(400, { ok: false, error: "expected a JSON object body" });
    if (!isFilledString(body.prompt)) {
      return ctx.json(400, { ok: false, error: "review requires a non-empty prompt" });
    }

    const timeout = body.timeoutSeconds;
    if (timeout !== undefined && !isPositiveNumber(timeout)) {
      return ctx.json(400, {
        ok: false,
        error: "timeoutSeconds must be a positive number of seconds (fractions allowed)",
      });
    }

    const project = resolveProject(body.project, api.defaultProject);
    if (!project) return ctx.json(400, { ok: false, error: INVALID_PROJECT });

    // The agent can vanish while we hold its call — Ctrl-C, a harness restart,
    // a dead proxy. Watch `res`, not `req`: a fully-read request stream closes
    // the moment its body is consumed (above), while the response closes either
    // when we answer or when the connection dies under us. Answering closes it
    // too, so the broker ends only the review this request still owns.
    const agentGone = new AbortController();
    ctx.res.on("close", () => agentGone.abort());

    let outcome: ReviewOutcome;
    try {
      outcome = await broker.requestReview({
        project,
        prompt: body.prompt,
        ...(typeof body.url === "string" ? { url: body.url } : {}),
        timeoutSeconds: timeout ?? DEFAULT_TIMEOUT_SECONDS,
        signal: agentGone.signal,
      });
    } catch (cause) {
      if (!(cause instanceof BusyError)) throw cause;
      return ctx.json(409, { ok: false, error: "busy" });
    }

    // Minutes may have passed: the agent could have walked away from the call.
    if (ctx.res.writableEnded || ctx.res.destroyed) return;
    ctx.json(200, outcome);
  });

  /** The page's answer. It carries only the review id — the pending review is
   *  what names the project, so no routing argument is needed here. */
  api.route("POST", "/reviews/:reviewId/verdict", async (ctx) => {
    const body = await readJsonRecord(ctx.req);
    if (!body) return ctx.json(400, { ok: false, error: "expected a JSON object body" });

    const verdict = body.verdict;
    if (verdict !== "approved" && verdict !== "changes") {
      return ctx.json(400, { ok: false, error: 'verdict must be "approved" or "changes"' });
    }

    const entryIds = body.entryIds;
    if (!Array.isArray(entryIds) || entryIds.some((id) => typeof id !== "string")) {
      return ctx.json(400, { ok: false, error: "entryIds must be an array of entry ids" });
    }

    const resolved = await broker.submitVerdict(ctx.params.reviewId!, verdict, entryIds as string[]);
    if (!resolved) {
      return ctx.json(404, { ok: false, error: `no pending review ${ctx.params.reviewId}` });
    }
    ctx.json(200, { ok: true });
  });

  api.route("GET", "/healthz", (ctx) => {
    ctx.json(200, { ok: true, name: "fixui-bridge", version: packageVersion() });
  });

  return api;
}

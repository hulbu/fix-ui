/**
 * The bridge's HTTP surface: `POST /entries`, `GET /entries`, `DELETE
 * /entries/:id` (plus the prototype's body-style `DELETE /entries {id}`, so one
 * transport client works bridge-less against an app-provided endpoint) and
 * `GET /healthz`.
 *
 * Loopback only — this is a local dev daemon, never a network service. CORS is
 * wide open because the callers are whatever origin the developer's app runs on.
 *
 * Routes live in a table so later features can register their own (the review
 * channel's `/events` and `/reviews/:id/verdict`) and reach shared state
 * through `ctx.server`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  appendEntry,
  listEntries,
  removeEntry,
  resolveProject,
  type JsonRecord,
} from "./storage.js";
import { packageVersion } from "./version.js";

export const HOST = "127.0.0.1";

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
  /** Register a route; `:name` segments become `ctx.params.name`. */
  route(method: string, pattern: string, handler: RouteHandler): void;
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
  let boundPort = opts.port;
  let http: Server | undefined;

  const api: BridgeServer = {
    get port() {
      return boundPort;
    },
    defaultProject: opts.defaultProject,

    route(method, pattern, handler) {
      routes.push({ method, segments: normalizePath(pattern).split("/"), handler });
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
  });

  api.route("GET", "/entries", async (ctx) => {
    const project = projectFromQuery(ctx);
    if (!project) return ctx.json(400, { ok: false, error: INVALID_PROJECT });

    ctx.json(200, { entries: await listEntries(project) });
  });

  api.route("DELETE", "/entries/:id", async (ctx) => {
    const project = projectFromQuery(ctx);
    if (!project) return ctx.json(400, { ok: false, error: INVALID_PROJECT });

    await removeEntry(project, ctx.params.id!);
    ctx.json(200, { ok: true });
  });

  // The prototype's body-style delete, kept so one transport client serves both.
  api.route("DELETE", "/entries", async (ctx) => {
    const body = await readJsonRecord(ctx.req);
    const id = body?.id;
    if (typeof id !== "string" && typeof id !== "number") {
      return ctx.json(400, { ok: false, error: "delete requires an id" });
    }

    const project = projectFromQuery(ctx);
    if (!project) return ctx.json(400, { ok: false, error: INVALID_PROJECT });

    await removeEntry(project, String(id));
    ctx.json(200, { ok: true });
  });

  api.route("GET", "/healthz", (ctx) => {
    ctx.json(200, { ok: true, name: "fixui-bridge", version: packageVersion() });
  });

  return api;
}

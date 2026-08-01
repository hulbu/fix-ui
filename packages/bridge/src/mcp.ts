/**
 * The MCP server (docs/agent-integration.md): `list_feedback`,
 * `resolve_feedback`, `request_review`, spoken over stdio to whatever harness
 * spawned this process.
 *
 * One server, two backends. `ReviewTools` is the seam: the daemon implements it
 * against its own broker and storage in-process, the proxy implements it by
 * forwarding to the daemon that already owns the port. Everything else — the
 * tool list, the argument checking, the result shape, the progress
 * notifications that keep a held `request_review` alive — is shared.
 *
 * The SDK's low-level `Server` is used on purpose: the high-level helper wants
 * Zod schemas, and the bridge's dependency budget is "node stdlib + the SDK".
 * JSON Schema goes on the wire and the arguments are checked here.
 */
import { request as httpRequest } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { BusyError, DEFAULT_TIMEOUT_SECONDS, type ReviewBroker, type ReviewOutcome } from "./broker.js";
import { listEntries, removeEntry, resolveProject, type JsonRecord } from "./storage.js";
import { packageVersion } from "./version.js";

/** How often a held `request_review` tells the client it is still waiting. */
const PROGRESS_MS = 10_000;

const INVALID_PROJECT = "project must be an absolute path to an existing directory";

export interface ReviewToolInput {
  prompt: string;
  url?: string;
  timeoutSeconds?: number;
  project?: string;
}

/** What the three tools need, however this process happens to be wired. */
export interface ReviewTools {
  listFeedback(project?: string): Promise<{ entries: JsonRecord[] }>;
  resolveFeedback(id: string, project?: string): Promise<{ ok: true }>;
  /** Resolves only when the review does; throws `BusyError` when busy. */
  requestReview(input: ReviewToolInput): Promise<ReviewOutcome>;
}

const PROJECT_PROPERTY = {
  type: "string",
  description: "Absolute path of the project directory; defaults to the bridge's own cwd.",
} as const;

const TOOLS: Tool[] = [
  {
    name: "list_feedback",
    description: "List the fix-ui feedback entries waiting in a project's inbox.",
    inputSchema: {
      type: "object",
      properties: { project: PROJECT_PROPERTY },
    },
  },
  {
    name: "resolve_feedback",
    description: "Remove one feedback entry from the inbox once it has been handled.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The entry's id." }, project: PROJECT_PROPERTY },
      required: ["id"],
    },
  },
  {
    name: "request_review",
    description:
      "Ask the human to review the running UI: the connected page arms itself, and this call " +
      "returns once they approve or request changes. Verdicts: approved | changes | timeout | " +
      "no-reviewer (nobody had the page open — ask in the terminal instead).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What the human should look at." },
        url: { type: "string", description: "Page the reviewer should be on; the page navigates." },
        timeoutSeconds: {
          type: "number",
          description: `How long to wait for a verdict (default ${DEFAULT_TIMEOUT_SECONDS}).`,
        },
        project: PROJECT_PROPERTY,
      },
      required: ["prompt"],
    },
  },
];

class ToolError extends Error {}

function text(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function failed(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function filledString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ToolError(`${field} must be a string`);
  return value;
}

export interface McpServerOptions {
  /** Progress-notification spacing; only tests have a reason to shorten it. */
  progressMs?: number;
}

/** Build the MCP server around whichever `ReviewTools` this process has. */
export function createMcpServer(tools: ReviewTools, options: McpServerOptions = {}): Server {
  const progressMs = options.progressMs ?? PROGRESS_MS;
  const server = new Server(
    { name: "fixui-bridge", version: packageVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as JsonRecord;
    try {
      switch (request.params.name) {
        case "list_feedback":
          return text(await tools.listFeedback(optionalString(args.project, "project")));

        case "resolve_feedback":
          return text(
            await tools.resolveFeedback(
              filledString(args.id, "id"),
              optionalString(args.project, "project"),
            ),
          );

        case "request_review": {
          const input: ReviewToolInput = { prompt: filledString(args.prompt, "prompt") };
          const url = optionalString(args.url, "url");
          if (url !== undefined) input.url = url;
          if (args.timeoutSeconds !== undefined) {
            if (typeof args.timeoutSeconds !== "number" || !(args.timeoutSeconds > 0)) {
              throw new ToolError("timeoutSeconds must be a positive number");
            }
            input.timeoutSeconds = args.timeoutSeconds;
          }
          const project = optionalString(args.project, "project");
          if (project !== undefined) input.project = project;

          // Long waits must not trip the client's tool timeout: clients that
          // honor progress notifications keep the call alive while we hold it.
          const token = extra._meta?.progressToken;
          const startedAt = Date.now();
          const ticker =
            token === undefined
              ? undefined
              : setInterval(() => {
                  const seconds = Math.round((Date.now() - startedAt) / 1000);
                  void extra
                    .sendNotification({
                      method: "notifications/progress",
                      params: {
                        progressToken: token,
                        progress: seconds,
                        message: `waiting for reviewer, ${seconds}s elapsed`,
                      },
                    })
                    .catch(() => undefined); // a client that hung up is not our problem
                }, progressMs);

          try {
            return text(await tools.requestReview(input));
          } finally {
            if (ticker) clearInterval(ticker);
          }
        }

        default:
          return failed(`unknown tool ${request.params.name}`);
      }
    } catch (cause) {
      // Errors travel as tool errors, not protocol errors: the agent should see
      // "busy" as text it can act on, exactly as docs/agent-integration.md says.
      return failed(cause instanceof BusyError ? "busy" : describe(cause));
    }
  });

  return server;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The inbox-change notification promised by docs/agent-integration.md. The
 * method is the bare `feedback/updated` the doc names: the SDK's
 * `assertNotificationCapability` switches only on the protocol's own
 * `notifications/*` methods and lets anything else through, and the client side
 * routes an unknown method to its fallback notification handler — so no
 * `notifications/` prefix is needed (or wanted: this is not a protocol
 * notification, and the prefix is the spec's namespace, not ours).
 */
export const FEEDBACK_UPDATED = "feedback/updated";

/** Watch inbox mutations; the returned function stops watching. */
export type InboxChanges = (listener: (project: string) => void) => () => void;

export interface StdioOptions {
  /**
   * Daemon mode only. The proxy has none: its MCP client is attached to *this*
   * process while the inbox is mutated in the daemon's, which has no way to
   * reach back here (docs/agent-integration.md).
   */
  onInboxChange?: InboxChanges;
}

export async function serveMcpOverStdio(
  tools: ReviewTools,
  options: StdioOptions = {},
): Promise<void> {
  const server = createMcpServer(tools);
  const { onInboxChange } = options;
  let unsubscribe: (() => void) | undefined;

  if (onInboxChange) {
    // Only once a client has completed the handshake. Stdio is wired whenever
    // this process was not started from a terminal, so a daemon nobody speaks
    // MCP to would otherwise write JSON-RPC frames at a stdout no client ever
    // initialized — noise at best, a protocol violation at worst.
    server.oninitialized = (): void => {
      unsubscribe = onInboxChange((project) => {
        // Fire-and-forget: an inbox write must never wait on — or fail because
        // of — a client that hung up mid-notification.
        void server
          .notification({ method: FEEDBACK_UPDATED, params: { project } })
          .catch(() => undefined);
      });
    };
    const closed = server.onclose;
    server.onclose = (): void => {
      unsubscribe?.();
      unsubscribe = undefined;
      closed?.();
    };
  }

  await server.connect(new StdioServerTransport());
}

/** Daemon mode: this process owns the broker and the inbox files. */
export function inProcessTools(broker: ReviewBroker, defaultProject: string): ReviewTools {
  const resolve = (requested?: string): string => {
    const project = resolveProject(requested, defaultProject);
    if (!project) throw new ToolError(INVALID_PROJECT);
    return project;
  };

  return {
    async listFeedback(project) {
      return { entries: await listEntries(resolve(project)) };
    },
    async resolveFeedback(id, project) {
      await removeEntry(resolve(project), id);
      // `{ok:true}` means "the entry is not in the inbox", matching what
      // `DELETE /entries/:id` answers — the proxy cannot tell more than that.
      return { ok: true };
    },
    requestReview(input) {
      return broker.requestReview({
        project: resolve(input.project),
        prompt: input.prompt,
        ...(input.url === undefined ? {} : { url: input.url }),
        timeoutSeconds: input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      });
    },
  };
}

/**
 * Proxy mode: another fixui-bridge owns the port, so the tools become HTTP
 * calls against it — scoped to *this* process's project, not the daemon's.
 *
 * `node:http` rather than `fetch`: global fetch dies on a held response after
 * undici's 300s headers timeout (measured: `UND_ERR_HEADERS_TIMEOUT` at 301s,
 * where the same wait over `node:http` returns fine at 330s), which would kill
 * a review before the daemon's own 600s default could answer it. The daemon
 * owns the clock; this side must not have one.
 */
export function httpTools(baseUrl: string, defaultProject: string): ReviewTools {
  const call = async (
    method: string,
    path: string,
    body?: JsonRecord,
  ): Promise<{ status: number; payload: JsonRecord }> => {
    const response = await send(`${baseUrl}${path}`, method, body);
    let payload: JsonRecord = {};
    try {
      const parsed: unknown = JSON.parse(response.body);
      if (typeof parsed === "object" && parsed !== null) payload = parsed as JsonRecord;
    } catch {
      throw new ToolError(`bridge daemon answered ${response.status} with a non-JSON body`);
    }
    return { status: response.status, payload };
  };

  const fail = (status: number, payload: JsonRecord): ToolError =>
    new ToolError(String(payload.error ?? `bridge daemon answered ${status}`));

  const ok = async (method: string, path: string, body?: JsonRecord): Promise<JsonRecord> => {
    const { status, payload } = await call(method, path, body);
    if (status >= 400) throw fail(status, payload);
    return payload;
  };

  const query = (project?: string): string =>
    `?project=${encodeURIComponent(project ?? defaultProject)}`;

  return {
    async listFeedback(project) {
      const payload = await ok("GET", `/entries${query(project)}`);
      return { entries: Array.isArray(payload.entries) ? (payload.entries as JsonRecord[]) : [] };
    },
    async resolveFeedback(id, project) {
      await ok("DELETE", `/entries/${encodeURIComponent(id)}${query(project)}`);
      return { ok: true };
    },
    async requestReview(input) {
      const { status, payload } = await call("POST", "/reviews", {
        prompt: input.prompt,
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
        project: input.project ?? defaultProject,
      });
      if (status === 409) throw new BusyError();
      if (status >= 400) throw fail(status, payload);
      return payload as unknown as ReviewOutcome;
    },
  };
}

/** A JSON round-trip with no client-side deadline of its own. */
function send(
  url: string,
  method: string,
  body?: JsonRecord,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = httpRequest(
      url,
      {
        method,
        headers: payload
          ? { "content-type": "application/json", "content-length": payload.length }
          : {},
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
        // Headers arrived, then the daemon died mid-body: with no client-side
        // deadline by design, an unsettled promise here would hang forever.
        res.on("aborted", () => reject(new Error("bridge daemon closed the connection")));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Everything the extension knows that isn't chrome.* glue: the options-page
 * origin→project map, the message shapes crossing the three trust boundaries
 * (page MAIN world → content script, content script → service worker, bridge
 * SSE → service worker), and the validators that make those crossings safe.
 *
 * Pure by construction — no chrome.*, no DOM, no network — because this is
 * the part worth unit-testing. The glue around it is covered end-to-end.
 */

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:3499";

/** MAIN-world payloads are page-controlled; caps apply before anything is kept. */
export const MAX_MAIN_MESSAGE = 1000;
export const MAX_MAIN_SOURCE = 300;
export const MAX_COMPONENT_NAME = 80;
export const MAX_REVIEW_PROMPT = 2000;

/** Control characters are what a hostile page (or a fat-fingered options line)
 *  would send; a surface description is read by an agent as one line. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** postMessage envelope tags — the two worlds share one window. */
export const MAIN_SOURCE = "fixui-main";
export const CONTENT_SOURCE = "fixui-content";
/** content → MAIN kinds: "which component is this?" and "stop capturing". */
export const COMPONENT_QUERY = "component-query";
export const CAPTURE_TOGGLE = "capture";
/**
 * The two worlds cannot pass an element reference to each other, but they do
 * share the DOM: the content script marks the element it is asking about with
 * this attribute (value = query token) and the MAIN world looks it up.
 */
export const PROBE_ATTRIBUTE = "data-fixui-probe";

/** runtime.sendMessage types (content → service worker). */
export const FETCH_MESSAGE = "fixui:fetch";
export const CONFIG_MESSAGE = "fixui:config";
/** tabs.sendMessage types (service worker → content). */
export const TOGGLE_OFF_MESSAGE = "fixui:toggle-off";
export const REVIEW_REQUESTED_MESSAGE = "fixui:review-requested";
export const REVIEW_CANCELLED_MESSAGE = "fixui:review-cancelled";

// --- options: origin → project ---------------------------------------------

export interface OriginMapping {
  /** Serialized origin, e.g. "https://app.example.com" (no trailing slash). */
  origin: string;
  /** Absolute project directory the bridge routes entries into. Absent on a
   *  label-only line: the notes go to the bridge's own cwd, as before. */
  project?: string;
  /**
   * A human name for pages on this origin, shown to the agent in
   * `list_surfaces` — "dev", "port 4001" (docs/agent-integration.md
   * "Surfaces"). This is how two ports of one app stay distinguishable when
   * they map to the same project.
   */
  label?: string;
}

export interface OriginMapError {
  /** 1-based, so the options page can point at the offending line. */
  line: number;
  text: string;
  reason: string;
}

export interface ParsedOriginMap {
  mappings: OriginMapping[];
  errors: OriginMapError[];
}

const SYNTAX = "expected origin=/absolute/path, e.g. https://app.example.com=/Users/me/app";
const BAD_ORIGIN = "origin must be an http(s) URL, e.g. https://app.example.com";
const BAD_PROJECT =
  "project must be an absolute path, e.g. /Users/me/app — or a |label alone, e.g. =|port 4001";

/** A label is one line of text an agent reads out of `list_surfaces`. */
export const MAX_SURFACE_LABEL = 80;

/** The serialized origin of an http(s) URL; undefined for anything else. */
export function originOf(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  return parsed.origin;
}

/**
 * One `origin=/absolute/path` per line; `#` comments and blank lines ignored.
 * Bad lines never poison the good ones — they come back as `errors` for the
 * options page to show. Exact origins only: no wildcards in v1, and an
 * unmapped origin simply travels without a `project`, which the bridge routes
 * to its own cwd.
 *
 * A trailing `|label` names the pages on that origin for the agent
 * (`list_surfaces`), and `origin=|label` labels an origin without mapping it
 * anywhere. Both are additions: a line with no `|` parses exactly as it always
 * did, so an existing map keeps working untouched.
 */
export function parseOriginMap(text: string): ParsedOriginMap {
  const mappings: OriginMapping[] = [];
  const errors: OriginMapError[] = [];
  const seen = new Set<string>();

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const fail = (reason: string): void => {
      errors.push({ line: i + 1, text: line, reason });
    };

    const split = line.indexOf("=");
    if (split <= 0) {
      fail(SYNTAX);
      continue;
    }

    const origin = originOf(line.slice(0, split).trim());
    if (!origin) {
      fail(BAD_ORIGIN);
      continue;
    }

    // The label is whatever follows the first `|` — after the project, so a
    // path may still contain `=` and an unlabelled line is unchanged.
    const value = line.slice(split + 1);
    const bar = value.indexOf("|");
    const project = (bar < 0 ? value : value.slice(0, bar)).trim();
    const label = bar < 0 ? undefined : surfaceLabel(value.slice(bar + 1));
    if (project === "" ? label === undefined : !project.startsWith("/")) {
      fail(BAD_PROJECT);
      continue;
    }

    if (seen.has(origin)) {
      fail(`duplicate origin ${origin} — the first mapping wins`);
      continue;
    }
    seen.add(origin);
    mappings.push({
      origin,
      ...(project === "" ? {} : { project }),
      ...(label === undefined ? {} : { label }),
    });
  }

  return { mappings, errors };
}

/** Trim, drop control characters, cap. Empty is no label at all. */
function surfaceLabel(raw: string): string | undefined {
  const cleaned = raw.replace(CONTROL_CHARS, "").trim();
  return cleaned === "" ? undefined : cleaned.slice(0, MAX_SURFACE_LABEL);
}

export function serializeOriginMap(mappings: OriginMapping[]): string {
  return mappings
    .map((m) => `${m.origin}=${m.project ?? ""}${m.label === undefined ? "" : `|${m.label}`}`)
    .join("\n");
}

/** Exact-origin lookup. No wildcards, no subdomain or port fuzz — see parseOriginMap. */
export function lookupProject(
  mappings: OriginMapping[],
  origin: string | undefined,
): string | undefined {
  if (!origin) return undefined;
  return mappings.find((m) => m.origin === origin)?.project;
}

/** The human name configured for this origin, if any. */
export function lookupLabel(
  mappings: OriginMapping[],
  origin: string | undefined,
): string | undefined {
  if (!origin) return undefined;
  return mappings.find((m) => m.origin === origin)?.label;
}

// --- options: bridge URL ----------------------------------------------------

/**
 * The manifest asks for host permissions on loopback http only (the bridge is
 * a local daemon and nothing else is any of this extension's business), so
 * anything else is a configuration error, not a fetch that fails later.
 */
export function isAllowedBridgeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
  );
}

/** chrome.storage.sync key and shape: written by the options page, read by the worker. */
export const OPTIONS_KEY = "fixui.options.v1";

export interface StoredOptions {
  bridgeUrl: string;
  /** Raw textarea contents — parsed with `parseOriginMap`, so a typo is
   *  reported rather than silently dropped on save. */
  originMap: string;
  /**
   * The bridge's review-channel token (it prints one at startup and writes it
   * to `.fix-ui.token` in its working directory). Without it the daemon answers
   * 401 on `GET /events` and on the verdict POST, so the agent-initiated review
   * direction is off and note-taking still works.
   */
  token?: string;
}

/** Normalize what the options page collected, or null when it is unusable. */
export function normalizeBridgeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return DEFAULT_BRIDGE_URL;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  if (!isAllowedBridgeUrl(withScheme)) return null;
  return new URL(withScheme).origin;
}

// --- surfaces: one stream per armed tab ------------------------------------

/** What the service worker remembers about a tab that is switched on. */
export interface TabState {
  /** Serialized origin, e.g. "https://app.example.com". */
  origin: string;
  /** From the options map; absent means "the bridge's own cwd". */
  project?: string;
  /** From the options map: this origin's human name, for `list_surfaces`. */
  label?: string;
  /** The page the tab was on when its stream was opened, and its title. Both
   *  are a snapshot: the stream deliberately survives a same-origin navigation
   *  (see `streamIdentity`), so they can lag the tab by one navigation. */
  url?: string;
  title?: string;
  /** Chrome's window id — what tells two windows on one site apart. */
  windowId?: number;
}

/** Keyed by tab id (as a string — session storage is JSON). */
export type TabStates = Record<string, TabState>;

/**
 * What a stream was opened FOR. The worker re-opens a tab's stream when this
 * changes and leaves it alone otherwise — in particular NOT for a same-origin
 * navigation, because reconnecting mints a new surfaceId and a review aimed at
 * this tab (possibly the very review that asked it to navigate) would lose the
 * page it was aimed at.
 */
export function streamIdentity(state: TabState): string {
  return `${state.project ?? ""}\u0000${state.origin}\u0000${state.label ?? ""}`;
}

/**
 * The `GET /events` URL for one armed tab — including what the bridge lists as
 * this tab's surface. The worker builds it here so the shape is unit-tested:
 * everything the agent later sees in `list_surfaces` starts on this line.
 *
 * The token never leaves the worker (a content script lives in a tab, and this
 * is the credential that decides who may answer the developer's review).
 */
export function streamUrl(
  bridgeUrl: string,
  tabId: string,
  state: TabState,
  token = "",
): string {
  const url = new URL(`${bridgeUrl.replace(/\/+$/, "")}/events`);
  // Capped here as well as at the bridge: a request line is not the place for
  // a page's idea of a long title.
  const set = (key: string, value: string | number | undefined, max = 300): void => {
    if (value === undefined) return;
    const text = typeof value === "number" ? String(value) : value.replace(CONTROL_CHARS, "").trim();
    if (text !== "") url.searchParams.set(key, text.slice(0, max));
  };
  set("project", state.project, 4000);
  if (token) set("token", token, 4000);
  set("origin", state.origin);
  set("url", state.url, 2000);
  set("title", state.title);
  set("label", state.label, MAX_SURFACE_LABEL);
  set("adapter", "extension");
  set("windowId", state.windowId);
  set("tabId", tabId);
  return url.href;
}

// --- fetch proxy (content script → service worker) --------------------------
// Content scripts inherit the page's mixed-content rules, so an https page
// cannot reach http://127.0.0.1 directly. The service worker holds the host
// permissions and does the fetch; this is the shape that travels.

export interface FetchProxyRequest {
  type: typeof FETCH_MESSAGE;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type FetchProxyResponse =
  | { ok: true; status: number; statusText: string; body: string }
  | { ok: false; error: string };

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) record[String(key).toLowerCase()] = String(value);
  } else if (typeof (headers as Headers).forEach === "function") {
    (headers as Headers).forEach((value, key) => {
      record[key.toLowerCase()] = value;
    });
  } else {
    for (const [key, value] of Object.entries(headers as Record<string, string>)) {
      record[key.toLowerCase()] = String(value);
    }
  }
  return record;
}

export function encodeFetchRequest(url: string, init: RequestInit = {}): FetchProxyRequest {
  const { body } = init;
  // Core only ever sends JSON strings; anything else would silently arrive at
  // the bridge as "[object Object]", so refuse it instead (the transport reads
  // a rejected fetch as "bridge unreachable" and queues the entry).
  if (body !== undefined && body !== null && typeof body !== "string") {
    throw new TypeError("fixui: only a string request body can cross the fetch proxy");
  }
  const request: FetchProxyRequest = {
    type: FETCH_MESSAGE,
    url,
    method: init.method ?? "GET",
    headers: headerRecord(init.headers),
  };
  if (typeof body === "string") request.body = body;
  return request;
}

/**
 * Service-worker side: shape + destination check before anything is fetched.
 *
 * The destination is checked against the *configured* bridge origin, not
 * merely "some loopback http URL". A content script runs in a page's tab and a
 * page that can talk it into a proxied fetch would otherwise reach every other
 * loopback service on the machine — an Ollama, an Elasticsearch, a Docker
 * socket over TCP — with the full response body handed back to it.
 */
export function parseFetchRequest(message: unknown, bridgeOrigin: string): FetchProxyRequest | null {
  if (typeof message !== "object" || message === null) return null;
  const msg = message as Record<string, unknown>;
  if (msg.type !== FETCH_MESSAGE) return null;
  if (typeof msg.url !== "string" || !isAllowedBridgeUrl(msg.url)) return null;
  if (new URL(msg.url).origin !== bridgeOrigin) return null;
  if (typeof msg.method !== "string") return null;
  if (typeof msg.headers !== "object" || msg.headers === null || Array.isArray(msg.headers)) {
    return null;
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(msg.headers)) {
    if (typeof value !== "string") return null;
    headers[key] = value;
  }
  if (msg.body !== undefined && typeof msg.body !== "string") return null;
  const request: FetchProxyRequest = { type: FETCH_MESSAGE, url: msg.url, method: msg.method, headers };
  if (typeof msg.body === "string") request.body = msg.body;
  return request;
}

/**
 * Content-script side. Throws on every failure — including a service worker
 * that answered nothing at all — because the caller is a `fetch` stand-in and
 * core's transport reads a rejection as "bridge unreachable, queue it".
 */
export function decodeFetchResponse(response: unknown): {
  status: number;
  statusText: string;
  body: string;
} {
  if (typeof response !== "object" || response === null) {
    throw new Error("fixui: no answer from the extension service worker");
  }
  const res = response as Record<string, unknown>;
  if (res.ok === false) {
    throw new Error(typeof res.error === "string" ? res.error : "fixui: bridge request failed");
  }
  if (typeof res.status !== "number" || typeof res.body !== "string") {
    throw new Error("fixui: malformed answer from the extension service worker");
  }
  return {
    status: res.status,
    statusText: typeof res.statusText === "string" ? res.statusText : "",
    body: res.body,
  };
}

// --- MAIN world → content script -------------------------------------------
// The MAIN world runs in the page's own reality: a hostile page can post
// anything it likes with our envelope on it. Everything below assumes exactly
// that — type-check, cap, and never throw (a throw here would break picking).

export type MainMessage =
  | { kind: "console-error"; message: string; source?: string }
  | { kind: "component-name"; token: number; name?: string };

function shortString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return trimmed.slice(0, max);
}

/** A component name is an identifier-ish label; a page saying otherwise is lying. */
function componentName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_COMPONENT_NAME) return undefined;
  // Control characters and newlines are exactly what a hostile page would send.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

export function parseMainMessage(data: unknown): MainMessage | null {
  try {
    if (typeof data !== "object" || data === null) return null;
    const msg = data as Record<string, unknown>;
    if (msg.source !== MAIN_SOURCE) return null;

    if (msg.kind === "console-error") {
      // Strings only into the ring buffer: core's push() assumes one.
      const message = shortString(msg.message, MAX_MAIN_MESSAGE);
      if (message === undefined) return null;
      const source = shortString(msg.sourceRef, MAX_MAIN_SOURCE);
      return source === undefined
        ? { kind: "console-error", message }
        : { kind: "console-error", message, source };
    }

    if (msg.kind === "component-name") {
      const { token } = msg;
      if (typeof token !== "number" || !Number.isInteger(token)) return null;
      const name = componentName(msg.name);
      return name === undefined
        ? { kind: "component-name", token }
        : { kind: "component-name", token, name };
    }

    return null;
  } catch {
    // Exotic payloads (throwing getters, proxies) must not take the picker down.
    return null;
  }
}

// --- bridge SSE (service worker) -------------------------------------------

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * `EventSource` is a window/worker interface that Chrome does not expose in an
 * extension service worker, so the review channel is a streamed `fetch` — which
 * means framing the wire format here: `field: value` lines, a blank line
 * dispatches, `:` lines are the bridge's heartbeats.
 */
export function createSseParser(): { push(chunk: string): SseEvent[] } {
  let buffered = "";
  let event = "";
  let data: string[] = [];

  return {
    push(chunk: string): SseEvent[] {
      buffered += chunk;
      const events: SseEvent[] = [];
      let index: number;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, index).replace(/\r$/, "");
        buffered = buffered.slice(index + 1);

        if (line === "") {
          if (data.length > 0) events.push({ event: event || "message", data: data.join("\n") });
          event = "";
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue; // comment / heartbeat

        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const raw = colon < 0 ? "" : line.slice(colon + 1);
        const value = raw.startsWith(" ") ? raw.slice(1) : raw;
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
        // id/retry and unknown fields are none of our business
      }
      return events;
    },
  };
}

/** The review a verdict POST resolves, so the worker can forget it. */
export function verdictReviewId(url: string): string | undefined {
  let pathname: string;
  try {
    ({ pathname } = new URL(url));
  } catch {
    return undefined;
  }
  const match = /^\/reviews\/([^/]+)\/verdict$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1];
  }
}

export interface ReviewRequestMessage {
  reviewId: string;
  prompt: string;
  url?: string;
  timeoutSeconds?: number;
}

/** The `review-requested` event body, validated before it reaches a picker. */
export function parseReviewRequested(data: string): ReviewRequestMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  const reviewId = shortString(body.reviewId, 200);
  const prompt = shortString(body.prompt, MAX_REVIEW_PROMPT);
  if (reviewId === undefined || prompt === undefined) return null;

  const request: ReviewRequestMessage = { reviewId, prompt };
  if (typeof body.url === "string") request.url = body.url;
  if (typeof body.timeoutSeconds === "number" && Number.isFinite(body.timeoutSeconds)) {
    request.timeoutSeconds = body.timeoutSeconds;
  }
  return request;
}

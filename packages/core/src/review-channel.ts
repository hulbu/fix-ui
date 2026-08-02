import type { Picker, ReviewRequest, ReviewVerdict } from "./picker";

/**
 * The adapter half of the review channel (docs/agent-integration.md
 * "Direction 2"): the bridge pushes `review-requested` / `review-cancelled`
 * over SSE, the page answers verdicts with a plain POST. Reconnection is the
 * browser's own EventSource retry — nothing to reimplement here.
 *
 * Every bit of IO is injected, so core stays testable and dependency-free.
 */
/**
 * What this page says it is, so an agent can tell it apart from the other page
 * on the same project — two windows, or the same app on two ports
 * (docs/agent-integration.md "Surfaces"). All of it travels as query
 * parameters on the stream and all of it is optional: a bridge that knows
 * nothing about surfaces ignores the lot.
 */
export interface SurfaceDescription {
  origin?: string;
  url?: string;
  title?: string;
  /** A human name for this page: "staging", "port 4001". */
  label?: string;
  adapter?: "embed" | "extension";
  windowId?: number;
  tabId?: number;
}

export interface ReviewChannelOptions {
  /** e.g. "http://127.0.0.1:3499" */
  bridgeUrl: string;
  /** Absolute project directory the bridge routes on; omitted → its own cwd. */
  project?: string;
  /** How this page introduces itself on the stream (see SurfaceDescription). */
  describe?: SurfaceDescription;
  /** Called once, with the id the bridge assigned this connection. */
  onSurface?: (surfaceId: string) => void;
  /**
   * The bridge's review token (it prints one at startup and writes it to
   * `.fix-ui.token` in its own cwd). Without it the daemon answers 401 on both
   * halves of this channel — any page the developer visits can reach a loopback
   * daemon, and a subscriber that learns a reviewId can answer the review in
   * the human's place. Travels in the query string on purpose: `EventSource`
   * cannot set headers, and a header would cost the verdict POST a preflight.
   */
  token?: string;
  picker: Picker;
  fetchImpl?: typeof fetch;
  eventSourceImpl?: typeof EventSource;
}

export interface ReviewChannel {
  /** The id the bridge gave this connection; undefined until it says so (and
   *  for a bridge too old to have surfaces at all). */
  readonly surfaceId: string | undefined;
  close(): void;
}

function parse(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Same-origin non-hash difference → a real navigation; hash-only → move the
 * fragment (no reload, so the review survives it); cross-origin → ignore,
 * a local bridge has no business steering the page off-site.
 */
function navigate(raw: string): void {
  let next: URL;
  let here: URL;
  try {
    next = new URL(raw, location.href);
    here = new URL(location.href);
  } catch {
    return;
  }
  if (next.origin !== here.origin || next.href === here.href) return;
  if (next.pathname === here.pathname && next.search === here.search) location.hash = next.hash;
  else location.assign(next.href);
}

export function connectReviewChannel(opts: ReviewChannelOptions): ReviewChannel {
  const base = opts.bridgeUrl.replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (opts.project) params.set("project", opts.project);
  if (opts.token) params.set("token", opts.token);
  for (const [key, value] of Object.entries(opts.describe ?? {})) {
    // Blank is not a description, and a number is only useful as one when it is
    // real; the bridge re-checks all of this anyway (it is browser-authored).
    if (typeof value === "string" && value.trim() !== "") params.set(key, value.trim());
    else if (typeof value === "number" && Number.isFinite(value)) params.set(key, String(value));
  }
  const search = params.toString();
  const query = search === "" ? "" : `?${search}`;
  const verdictQuery = opts.token ? `?token=${encodeURIComponent(opts.token)}` : "";
  const EventSourceImpl = opts.eventSourceImpl ?? globalThis.EventSource;
  const source = new EventSourceImpl(`${base}/events${query}`);
  let surfaceId: string | undefined;

  function onRequested(event: MessageEvent): void {
    const data = parse(event.data);
    if (!data || typeof data.reviewId !== "string" || typeof data.prompt !== "string") return;
    const request: ReviewRequest = { reviewId: data.reviewId, prompt: data.prompt };
    if (typeof data.url === "string") request.url = data.url;
    if (typeof data.timeoutSeconds === "number") request.timeoutSeconds = data.timeoutSeconds;
    if (request.url) navigate(request.url);
    opts.picker.startReview(request);
  }

  function onCancelled(): void {
    opts.picker.endReview();
  }

  /** The bridge's handshake: the id an agent's `request_review({surfaceId})`
   *  aims at. Absent on an older bridge, which simply means untargeted reviews. */
  function onSurface(event: MessageEvent): void {
    const data = parse(event.data);
    if (!data || typeof data.surfaceId !== "string" || data.surfaceId === "") return;
    surfaceId = data.surfaceId;
    opts.onSurface?.(surfaceId);
  }

  async function postVerdict(verdict: ReviewVerdict): Promise<void> {
    const impl = opts.fetchImpl ?? globalThis.fetch;
    if (typeof impl !== "function") return;
    try {
      await impl(`${base}/reviews/${encodeURIComponent(verdict.reviewId)}/verdict${verdictQuery}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict: verdict.verdict, entryIds: verdict.entryIds }),
      });
    } catch {
      // Bridge gone — the held tool call times out agent-side, which is a
      // first-class verdict there. Nothing useful to retry against.
    }
  }

  source.addEventListener("surface", onSurface);
  source.addEventListener("review-requested", onRequested);
  source.addEventListener("review-cancelled", onCancelled);
  const unsubscribe = opts.picker.onVerdict((verdict) => void postVerdict(verdict));

  return {
    get surfaceId() {
      return surfaceId;
    },
    close() {
      unsubscribe();
      source.removeEventListener("surface", onSurface);
      source.removeEventListener("review-requested", onRequested);
      source.removeEventListener("review-cancelled", onCancelled);
      source.close();
    },
  };
}

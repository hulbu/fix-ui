import type { Picker, ReviewRequest, ReviewVerdict } from "./picker";

/**
 * The adapter half of the review channel (docs/agent-integration.md
 * "Direction 2"): the bridge pushes `review-requested` / `review-cancelled`
 * over SSE, the page answers verdicts with a plain POST. Reconnection is the
 * browser's own EventSource retry — nothing to reimplement here.
 *
 * Every bit of IO is injected, so core stays testable and dependency-free.
 */
export interface ReviewChannelOptions {
  /** e.g. "http://127.0.0.1:3499" */
  bridgeUrl: string;
  /** Absolute project directory the bridge routes on; omitted → its own cwd. */
  project?: string;
  picker: Picker;
  fetchImpl?: typeof fetch;
  eventSourceImpl?: typeof EventSource;
}

export interface ReviewChannel {
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
  const query = opts.project ? `?project=${encodeURIComponent(opts.project)}` : "";
  const EventSourceImpl = opts.eventSourceImpl ?? globalThis.EventSource;
  const source = new EventSourceImpl(`${base}/events${query}`);

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

  async function postVerdict(verdict: ReviewVerdict): Promise<void> {
    const impl = opts.fetchImpl ?? globalThis.fetch;
    if (typeof impl !== "function") return;
    try {
      await impl(`${base}/reviews/${encodeURIComponent(verdict.reviewId)}/verdict`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict: verdict.verdict, entryIds: verdict.entryIds }),
      });
    } catch {
      // Bridge gone — the held tool call times out agent-side, which is a
      // first-class verdict there. Nothing useful to retry against.
    }
  }

  source.addEventListener("review-requested", onRequested);
  source.addEventListener("review-cancelled", onCancelled);
  const unsubscribe = opts.picker.onVerdict((verdict) => void postVerdict(verdict));

  return {
    close() {
      unsubscribe();
      source.removeEventListener("review-requested", onRequested);
      source.removeEventListener("review-cancelled", onCancelled);
      source.close();
    },
  };
}

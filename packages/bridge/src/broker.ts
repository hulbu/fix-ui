/**
 * The review broker (docs/agent-integration.md "Direction 2"): it holds the
 * agent's `request_review` call open, pushes the request to whatever adapters
 * are watching that project, and settles the call on the human's verdict or on
 * the timeout — whichever comes first.
 *
 * State is in memory and lives as long as the daemon: a review is a
 * conversation between a running agent and a live page, not something worth
 * surviving a restart. The only disk this module touches is through storage.ts
 * (the inbox lookup a verdict needs, and the review record).
 *
 * Deliberately HTTP-free: a subscriber is anything with `send(event, data)`,
 * and server.ts is what decides that "send" means an SSE frame.
 *
 * Scope discipline (v1): one review at a time per project — a second request
 * for a busy project fails with `busy` rather than queueing (queues are v2).
 */
import { randomUUID } from "node:crypto";
import { appendReview, listEntries, type JsonRecord } from "./storage.js";

/** docs/agent-integration.md "Tool shape". Fractions are allowed — tests use
 *  sub-second timeouts, and nothing in the protocol needs whole seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 600;

/** `setTimeout` overflows past 2^31-1 ms — it would warn on stderr (which MCP
 *  mode keeps clean) and fire at once, turning a long wait into an instant
 *  timeout. Clamping to ~24 days is indistinguishable from "forever" here. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export type ReviewVerdict = "approved" | "changes" | "timeout" | "no-reviewer";
/** The two a human can send; `timeout` and `no-reviewer` are the bridge's own. */
export type HumanVerdict = "approved" | "changes";

export interface ReviewOutcome {
  verdict: ReviewVerdict;
  /** The notes left during the review, in the order the page reported them. */
  entries: JsonRecord[];
  durationMs: number;
}

export interface ReviewRequest {
  /** Resolved absolute project directory — the broker's key for everything. */
  project: string;
  prompt: string;
  url?: string;
  timeoutSeconds: number;
}

export type ReviewEvent = "review-requested" | "review-cancelled";

export interface ReviewSubscriber {
  send(event: ReviewEvent, data: JsonRecord): void;
}

/** A second review while one is pending for the same project. An error, never
 *  a verdict (docs/agent-integration.md: "fails fast with a `busy` tool error"). */
export class BusyError extends Error {
  constructor() {
    super("busy");
    this.name = "BusyError";
  }
}

export interface ReviewBroker {
  /** Watch a project; the returned function stops watching. A review pending
   *  for that project is replayed to the new subscriber immediately. */
  subscribe(project: string, subscriber: ReviewSubscriber): () => void;
  /** Resolves only when the review resolves. Throws `BusyError` when the
   *  project already has one pending. */
  requestReview(request: ReviewRequest): Promise<ReviewOutcome>;
  /** `false` when the id is unknown or already resolved (the caller's 404). */
  submitVerdict(reviewId: string, verdict: HumanVerdict, entryIds: string[]): Promise<boolean>;
  /** Daemon shutdown: no timer and no held call may outlive the server. */
  stop(): void;
}

interface Pending extends ReviewRequest {
  id: string;
  requestedAt: Date;
  startedAt: number;
  timer: NodeJS.Timeout;
  settle(outcome: ReviewOutcome): void;
}

export function createReviewBroker(): ReviewBroker {
  const subscribers = new Map<string, Set<ReviewSubscriber>>();
  const pending = new Map<string, Pending>(); // project → the one review it may have

  /** One subscriber's dead socket must not cost the others their event. */
  function deliver(subscriber: ReviewSubscriber, event: ReviewEvent, data: JsonRecord): void {
    try {
      subscriber.send(event, data);
    } catch {
      // Nothing to do: the stream is gone and its `close` will unsubscribe it.
    }
  }

  function broadcast(project: string, event: ReviewEvent, data: JsonRecord): void {
    for (const subscriber of subscribers.get(project) ?? []) deliver(subscriber, event, data);
  }

  function requestedPayload(review: Pending): JsonRecord {
    return {
      reviewId: review.id,
      prompt: review.prompt,
      ...(review.url === undefined ? {} : { url: review.url }),
      timeoutSeconds: review.timeoutSeconds,
    };
  }

  /** Remove a pending review from play exactly once, timer and all. */
  function take(reviewId: string): Pending | undefined {
    // Verdicts arrive from the page carrying only the review id (the adapter
    // has no project to send), so the review itself is what names its project.
    for (const review of pending.values()) {
      if (review.id !== reviewId) continue;
      pending.delete(review.project);
      clearTimeout(review.timer);
      return review;
    }
    return undefined;
  }

  function expire(review: Pending): void {
    if (pending.get(review.project) !== review) return; // already settled
    pending.delete(review.project);
    review.settle({ verdict: "timeout", entries: [], durationMs: Date.now() - review.startedAt });
    // Stand the page's review banner down; it has no other way to learn.
    broadcast(review.project, "review-cancelled", { reviewId: review.id });
  }

  /** The full entries behind the ids the page reported, missing ones absent. */
  async function lookupEntries(project: string, entryIds: string[]): Promise<JsonRecord[]> {
    if (entryIds.length === 0) return []; // the common "approved" case reads nothing
    const byId = new Map<string, JsonRecord>();
    for (const entry of await listEntries(project)) {
      const id = entry.id;
      if (typeof id !== "string" && typeof id !== "number") continue;
      if (!byId.has(String(id))) byId.set(String(id), entry);
    }
    return entryIds
      .map((id) => byId.get(id))
      .filter((entry): entry is JsonRecord => entry !== undefined);
  }

  return {
    subscribe(project, subscriber) {
      const watchers = subscribers.get(project) ?? new Set<ReviewSubscriber>();
      subscribers.set(project, watchers);
      watchers.add(subscriber);

      // A reload or a navigation drops the stream mid-review. The page that
      // comes back must re-arm itself, so it gets the pending review on connect.
      const review = pending.get(project);
      if (review) deliver(subscriber, "review-requested", requestedPayload(review));

      return () => {
        watchers.delete(subscriber);
        if (watchers.size === 0 && subscribers.get(project) === watchers) {
          subscribers.delete(project); // idle projects leave no trace
        }
      };
    },

    requestReview(request) {
      if (pending.has(request.project)) return Promise.reject(new BusyError());
      // Nobody is watching: answer now so the agent can fall back to asking in
      // the terminal instead of hanging for ten minutes.
      if ((subscribers.get(request.project)?.size ?? 0) === 0) {
        return Promise.resolve({ verdict: "no-reviewer", entries: [], durationMs: 0 });
      }

      let settle!: (outcome: ReviewOutcome) => void;
      const held = new Promise<ReviewOutcome>((resolve) => {
        settle = resolve;
      });
      const review: Pending = {
        ...request,
        id: randomUUID(),
        requestedAt: new Date(),
        startedAt: Date.now(),
        timer: setTimeout(
          () => expire(review),
          Math.min(Math.round(request.timeoutSeconds * 1000), MAX_TIMEOUT_MS),
        ),
        settle,
      };
      pending.set(request.project, review);
      broadcast(request.project, "review-requested", requestedPayload(review));
      return held;
    },

    async submitVerdict(reviewId, verdict, entryIds) {
      const review = take(reviewId);
      if (!review) return false;

      const resolvedAt = new Date();
      let entries: JsonRecord[] = [];
      try {
        entries = await lookupEntries(review.project, entryIds);
        // The audit trail (docs/capture-format.md "Review session records").
        await appendReview(review.project, {
          id: review.id,
          prompt: review.prompt,
          verdict,
          entryIds,
          requestedAt: review.requestedAt.toISOString(),
          resolvedAt: resolvedAt.toISOString(),
        });
      } finally {
        // The human answered: the held call resolves even if the inbox or the
        // record file turned out unreadable — the caller still reports that.
        review.settle({ verdict, entries, durationMs: resolvedAt.getTime() - review.startedAt });
      }
      return true;
    },

    stop() {
      for (const review of pending.values()) {
        clearTimeout(review.timer);
        review.settle({
          verdict: "timeout",
          entries: [],
          durationMs: Date.now() - review.startedAt,
        });
      }
      pending.clear();
      subscribers.clear();
    },
  };
}

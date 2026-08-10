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

/**
 * Which question the page asks, and therefore which answer comes back
 * (docs/agent-integration.md "Sessions").
 *
 * `review` asks a yes-or-no question about a change the agent just made.
 * `session` is the batched, human-led mode: the agent stands by while the user
 * points at as many things as they like, and one Submit hands the batch over.
 * Everything else — the held call, the timeout, `busy`, surface targeting — is
 * the same machinery, which is the whole reason it is a mode and not a second
 * channel.
 */
export type ReviewMode = "review" | "session";

export type ReviewVerdict = "approved" | "changes" | "submitted" | "timeout" | "no-reviewer";
/** The three a human can send; `timeout` and `no-reviewer` are the bridge's own. */
export type HumanVerdict = "approved" | "changes" | "submitted";

export interface ReviewOutcome {
  verdict: ReviewVerdict;
  /** The notes left during the review, in the order the page reported them. */
  entries: JsonRecord[];
  durationMs: number;
}

/** Which adapter is holding a surface open — the two halves of the product. */
export type SurfaceAdapter = "embed" | "extension";

/**
 * What a page says about itself when it subscribes, so an agent can tell two
 * connected pages apart (docs/agent-integration.md "Surfaces"). Every field is
 * optional and every field is UNTRUSTED: it crossed from a browser, and the
 * caller is expected to have capped and sanitized it (server.ts does).
 */
export interface SurfaceDescription {
  origin?: string;
  url?: string;
  title?: string;
  /** A human name for this page — `initFixUi({label})`, or the options map. */
  label?: string;
  adapter?: SurfaceAdapter;
  /** Chrome's own ids, so two windows on one site are told apart honestly. */
  windowId?: number;
  tabId?: number;
}

/** One connected page that can host a review. */
export interface Surface extends SurfaceDescription {
  /** Bridge-generated, per subscription: the handle `request_review` aims at. */
  surfaceId: string;
  project: string;
  connectedAt: string;
}

export interface ReviewRequest {
  /** Resolved absolute project directory — the broker's key for everything. */
  project: string;
  prompt: string;
  url?: string;
  timeoutSeconds: number;
  /** Absent means `review`, and the page is never told about that one: a build
   *  that has never heard of modes must keep working unchanged. */
  mode?: ReviewMode;
  /**
   * Aim the review at ONE connected page instead of all of the project's
   * (docs/agent-integration.md "Surfaces"). An id that is unknown, gone, or on
   * a different project answers `no-reviewer` — never a quiet broadcast to
   * everybody, because a targeting mistake the agent cannot see is worse than
   * one it can.
   */
  surfaceId?: string;
  /**
   * Aborts when the agent that asked for the review is gone (its HTTP call
   * dropped, its harness restarted). The review ends there: nothing would ever
   * read its outcome, and leaving it pending would wedge the project as `busy`
   * — and leave the page still asking — for the rest of the timeout.
   */
  signal?: AbortSignal;
}

/**
 * `surface` is the handshake — the id this subscription was given, sent before
 * anything else; the next two are the review itself.
 *
 * `inbox-changed` belongs to neither: it says the project's inbox is not what
 * the page last read, whoever changed it and whether or not a review is
 * running. Without it the picker only ever re-read the inbox when the user
 * opened the panel, so an agent resolving entries left a stale count on the
 * chip until it was clicked.
 */
export type ChannelEvent =
  | "surface"
  | "review-requested"
  | "review-cancelled"
  | "inbox-changed";

export interface ReviewSubscriber {
  send(event: ChannelEvent, data: JsonRecord): void;
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
  /**
   * Watch a project; the returned function stops watching. The subscription is
   * a *surface*: it is given an id (sent as the `surface` event, before
   * anything else) and appears in `listSurfaces` until it goes away.
   *
   * An UNTARGETED review pending for that project is replayed to the new
   * subscriber immediately — a stream can drop mid-review and the page that
   * comes back has to re-arm. A targeted one is not: its surface is gone, and
   * the page that reconnected is a different one.
   */
  subscribe(
    project: string,
    subscriber: ReviewSubscriber,
    describe?: SurfaceDescription,
  ): () => void;
  /** Connected pages, newest first; scoped to one project when given. */
  listSurfaces(project?: string): Surface[];
  /**
   * Tell every page of a project that its inbox moved. Deliberately not tied to
   * a review: notes are created and resolved outside one all the time, and the
   * page's badge is wrong the moment either happens. Fire-and-forget, like every
   * other send here — a dead stream costs the others nothing.
   */
  inboxChanged(project: string): void;
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

/** A surface and the stream it speaks through. The subscriber is deliberately
 *  not part of `Surface`: that shape is answered to an agent over HTTP. */
interface Connected {
  surface: Surface;
  subscriber: ReviewSubscriber;
}

export function createReviewBroker(): ReviewBroker {
  /** surfaceId → the page holding it. Insertion order is connection order,
   *  which is what "newest first" reverses. */
  const surfaces = new Map<string, Connected>();
  const pending = new Map<string, Pending>(); // project → the one review it may have

  /** One subscriber's dead socket must not cost the others their event. */
  function deliver(subscriber: ReviewSubscriber, event: ChannelEvent, data: JsonRecord): void {
    try {
      subscriber.send(event, data);
    } catch {
      // Nothing to do: the stream is gone and its `close` will unsubscribe it.
    }
  }

  function broadcast(project: string, event: ChannelEvent, data: JsonRecord): void {
    for (const { surface, subscriber } of surfaces.values()) {
      if (surface.project === project) deliver(subscriber, event, data);
    }
  }

  /** The one surface a review names, or undefined when it names none, names one
   *  that has gone away, or names one belonging to another project. */
  function targetOf(review: { project: string; surfaceId?: string }): Connected | undefined {
    if (review.surfaceId === undefined) return undefined;
    const connected = surfaces.get(review.surfaceId);
    return connected?.surface.project === review.project ? connected : undefined;
  }

  /** Where a review's events go: exactly its surface, or the whole project. */
  function announce(review: Pending, event: ChannelEvent, data: JsonRecord): void {
    if (review.surfaceId === undefined) {
      broadcast(review.project, event, data);
      return;
    }
    const target = targetOf(review);
    if (target) deliver(target.subscriber, event, data);
    // Otherwise nothing: the page it was aimed at is gone. Delivering to the
    // rest of the project instead would be exactly the silent mis-aim that
    // `no-reviewer` exists to prevent.
  }

  function requestedPayload(review: Pending): JsonRecord {
    return {
      reviewId: review.id,
      prompt: review.prompt,
      ...(review.url === undefined ? {} : { url: review.url }),
      // Stated only when it is not the default: an older page ignores what it
      // does not know, and a newer one reads its absence as "a review".
      ...(review.mode === "session" ? { mode: review.mode } : {}),
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

  /**
   * End a review no human verdict will ever reach, and take the request off
   * down — it has no other way to learn (docs/agent-integration.md:
   * `review-cancelled` is "timeout or agent abort"). Identity, not id, is the
   * guard: a review that already resolved is not this object any more, so a
   * late abort signal is a no-op rather than somebody else's cancellation.
   */
  function endWithoutVerdict(review: Pending): boolean {
    if (pending.get(review.project) !== review) return false;
    pending.delete(review.project);
    clearTimeout(review.timer);
    // Stood down where it was raised — a targeted review is only showing on
    // the surface it named.
    announce(review, "review-cancelled", { reviewId: review.id });
    return true;
  }

  function timedOut(review: Pending): ReviewOutcome {
    return { verdict: "timeout", entries: [], durationMs: Date.now() - review.startedAt };
  }

  function expire(review: Pending): void {
    if (!endWithoutVerdict(review)) return;
    // A timeout is an outcome, so it joins the audit trail — recorded before
    // the agent is answered, the way a verdict is.
    void recordTimeout(review);
  }

  async function recordTimeout(review: Pending): Promise<void> {
    try {
      await appendReview(review.project, {
        id: review.id,
        prompt: review.prompt,
        verdict: "timeout",
        entryIds: [],
        requestedAt: review.requestedAt.toISOString(),
        resolvedAt: new Date().toISOString(),
      });
    } catch {
      // An unwritable audit file must not take the daemon down (and there is no
      // request left to report it on) — the agent still gets its verdict below.
    } finally {
      review.settle(timedOut(review));
    }
  }

  /** The agent hung up mid-review: no outcome was produced and nobody is left
   *  to read one, so nothing is recorded. Settling only frees the held call. */
  function abandon(review: Pending): void {
    if (!endWithoutVerdict(review)) return;
    review.settle(timedOut(review));
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

  const noReviewer = (): ReviewOutcome => ({
    verdict: "no-reviewer",
    entries: [],
    durationMs: 0,
  });

  function watching(project: string): boolean {
    for (const { surface } of surfaces.values()) if (surface.project === project) return true;
    return false;
  }

  return {
    subscribe(project, subscriber, describe = {}) {
      const surfaceId = randomUUID();
      const connected: Connected = {
        surface: { ...describe, surfaceId, project, connectedAt: new Date().toISOString() },
        subscriber,
      };
      surfaces.set(surfaceId, connected);
      // First, before anything else on this stream: the page cannot report the
      // id it was given if it learns it after the events that use it.
      deliver(subscriber, "surface", { surfaceId });

      // A reload or a navigation drops the stream mid-review. The page that
      // comes back must re-arm itself, so it gets the pending review on connect
      // — unless that review named a surface, in which case the page in front
      // of us is not the one it was aimed at.
      const review = pending.get(project);
      if (review !== undefined && review.surfaceId === undefined) {
        deliver(subscriber, "review-requested", requestedPayload(review));
      }

      return () => {
        // Identity, not id: a surface that was already replaced is not ours to
        // remove (and none is, today — ids are fresh per subscription).
        if (surfaces.get(surfaceId) === connected) surfaces.delete(surfaceId);
      };
    },

    listSurfaces(project) {
      const listed: Surface[] = [];
      for (const { surface } of surfaces.values()) {
        if (project === undefined || surface.project === project) listed.push({ ...surface });
      }
      return listed.reverse(); // newest first
    },

    inboxChanged(project) {
      broadcast(project, "inbox-changed", { project });
    },

    requestReview(request) {
      if (pending.has(request.project)) return Promise.reject(new BusyError());
      // Nobody is watching — or nobody is watching at the surface the agent
      // aimed at. Answer now so it can fall back to asking in the terminal (or
      // call `list_surfaces` and aim again) instead of hanging for ten minutes.
      if (request.surfaceId === undefined) {
        if (!watching(request.project)) return Promise.resolve(noReviewer());
      } else if (!targetOf(request)) {
        return Promise.resolve(noReviewer());
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
      // `once`: the request's own signal dies with the request, and a late
      // abort (the normal end of every answered call) finds nothing to end.
      request.signal?.addEventListener("abort", () => abandon(review), { once: true });
      announce(review, "review-requested", requestedPayload(review));
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
      surfaces.clear();
    },
  };
}

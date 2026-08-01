/**
 * The review channel end to end over real HTTP (docs/agent-integration.md
 * "Direction 2"): a held `POST /reviews`, the adapter's SSE stream, and the
 * verdict that resolves the held call.
 *
 * Node has no `EventSource`, so the stream is parsed by hand from
 * `fetch().body` — which is also closer to what an intermediary sees than a
 * polyfill would be. Timeouts are *real* (fake timers can't reach across a
 * socket), so the timeout cases use fractional `timeoutSeconds`.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createBridgeServer, type BridgeServer } from "./server.js";
import { reviewsPath } from "./storage.js";

const JSON_HEADERS = { "content-type": "application/json" };

let server: BridgeServer;
let projectDir: string;
let otherDir: string;
let base: string;

interface SseEvent {
  event: string;
  data: Record<string, any>;
}

interface SseStream {
  readonly events: SseEvent[];
  readonly comments: string[];
  /** Resolves with the data of the nth (1-based) event of this name. */
  next(event: string, nth?: number): Promise<Record<string, any>>;
  close(): void;
}

const streams: SseStream[] = [];
const held: Promise<unknown>[] = [];

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "fixui-review-"));
  otherDir = await mkdtemp(path.join(tmpdir(), "fixui-review-other-"));
  server = createBridgeServer({ port: 0, defaultProject: projectDir, heartbeatMs: 40 });
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close();
  await server.stop();
  await Promise.allSettled(held.splice(0)); // held calls die with the daemon
  await rm(projectDir, { recursive: true, force: true });
  await rm(otherDir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Open `GET /events` and parse the SSE frames as they arrive. */
async function openStream(project?: string): Promise<SseStream> {
  const query = project ? `?project=${encodeURIComponent(project)}` : "";
  const controller = new AbortController();
  const res = await fetch(`${base}/events${query}`, { signal: controller.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  const events: SseEvent[] = [];
  const comments: string[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        let name = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith(":")) comments.push(line);
          else if (line.startsWith("event:")) name = line.slice("event:".length).trim();
          else if (line.startsWith("data:")) data += line.slice("data:".length).trim();
        }
        if (data !== "") events.push({ event: name, data: JSON.parse(data) as Record<string, any> });
      }
    }
  })().catch(() => undefined); // aborting the stream rejects the read in flight

  const stream: SseStream = {
    events,
    comments,
    async next(event, nth = 1) {
      const matching = (): SseEvent[] => events.filter((entry) => entry.event === event);
      await waitFor(() => matching().length >= nth, `SSE ${event} #${nth}`);
      return matching()[nth - 1]!.data;
    },
    close() {
      controller.abort();
    },
  };
  streams.push(stream);
  return stream;
}

/** `POST /reviews` stays open until the review resolves — never await it eagerly. */
function requestReview(body: Record<string, unknown>): Promise<Response> {
  const pending = fetch(`${base}/reviews`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  held.push(pending.catch(() => undefined));
  return pending;
}

function postVerdict(reviewId: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/reviews/${encodeURIComponent(reviewId)}/verdict`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** A note dropped during a review is an ordinary entry. */
function postEntry(id: string, note: string, project?: string): Promise<Response> {
  return fetch(`${base}/entries`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      v: 1,
      id,
      note,
      selector: `#${id}`,
      url: "http://localhost:4001/",
      viewport: { width: 1280, height: 800 },
      userAgent: "test-agent",
      createdAt: "2026-07-31T09:00:00.000Z",
      ...(project ? { project } : {}),
    }),
  });
}

async function body(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

async function reviewRecords(dir: string): Promise<Record<string, any>[]> {
  const raw = await readFile(reviewsPath(dir), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

it("request→SSE review-requested→notes→verdict 'changes' resolves the held POST /reviews with entries and appends the review record", async () => {
  const stream = await openStream();

  const call = requestReview({
    prompt: "Review the new pricing table",
    url: "http://localhost:4001/#pricing",
    timeoutSeconds: 5,
  });

  const requested = await stream.next("review-requested");
  expect(requested).toMatchObject({
    prompt: "Review the new pricing table",
    url: "http://localhost:4001/#pricing",
    timeoutSeconds: 5,
  });
  expect(typeof requested.reviewId).toBe("string");

  // The human leaves two notes, then asks for changes.
  await postEntry("n1", "tighten the spacing");
  await postEntry("n2", "the CTA is the wrong orange");

  const verdict = await postVerdict(requested.reviewId, {
    verdict: "changes",
    entryIds: ["n2", "n1", "gone"], // an id the inbox no longer has is simply absent
  });
  expect(verdict.status).toBe(200);
  expect(await body(verdict)).toEqual({ ok: true });

  const outcome = await body(await call);
  expect(outcome.verdict).toBe("changes");
  expect(outcome.entries.map((entry: any) => entry.id)).toEqual(["n2", "n1"]);
  expect(outcome.entries[0]).toMatchObject({ note: "the CTA is the wrong orange", selector: "#n2" });
  expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  expect(Object.keys(outcome).sort()).toEqual(["durationMs", "entries", "verdict"]);

  const records = await reviewRecords(projectDir);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    id: requested.reviewId,
    prompt: "Review the new pricing table",
    verdict: "changes",
    entryIds: ["n2", "n1", "gone"],
  });
  expect(new Date(records[0]!.requestedAt).toISOString()).toBe(records[0]!.requestedAt);
  expect(new Date(records[0]!.resolvedAt).toISOString()).toBe(records[0]!.resolvedAt);
});

it("approve with no notes resolves {verdict:'approved',entries:[]}", async () => {
  const stream = await openStream();
  const call = requestReview({ prompt: "Does the hero look right?", timeoutSeconds: 5 });
  const { reviewId } = await stream.next("review-requested");

  expect(await body(await postVerdict(reviewId, { verdict: "approved", entryIds: [] }))).toEqual({
    ok: true,
  });

  const outcome = await body(await call);
  expect(outcome.verdict).toBe("approved");
  expect(outcome.entries).toEqual([]);

  // The same verdict twice: the review is gone, so the second one is a 404.
  const again = await postVerdict(reviewId, { verdict: "approved", entryIds: [] });
  expect(again.status).toBe(404);
  expect((await body(again)).ok).toBe(false);

  expect((await reviewRecords(projectDir))[0]).toMatchObject({ verdict: "approved", entryIds: [] });

  // Answering closes the agent's request too — that must not read as an abort.
  await new Promise((done) => setTimeout(done, 100));
  expect(stream.events.filter((event) => event.event === "review-cancelled")).toEqual([]);
  expect(stream.events.filter((event) => event.event === "review-requested")).toHaveLength(1);
});

it("the agent hanging up ends the review: review-cancelled, and the project is free at once", async () => {
  const stream = await openStream();

  // The agent's held call, then the agent dies (Ctrl-C, harness restart).
  const controller = new AbortController();
  const abandoned = fetch(`${base}/reviews`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ prompt: "agent goes away", timeoutSeconds: 30 }),
    signal: controller.signal,
  });
  held.push(abandoned.catch(() => undefined));
  const { reviewId } = await stream.next("review-requested");
  controller.abort();

  await expect(abandoned).rejects.toThrow();
  expect(await stream.next("review-cancelled")).toEqual({ reviewId });

  // No 30-second wedge: the next review starts immediately instead of `busy`.
  const next = requestReview({ prompt: "fresh start", timeoutSeconds: 5 });
  const requested = await stream.next("review-requested", 2);
  expect(requested.prompt).toBe("fresh start");
  await postVerdict(requested.reviewId, { verdict: "approved", entryIds: [] });
  expect((await body(await next)).verdict).toBe("approved");

  // The abandoned call produced no outcome, so it left no audit line.
  expect((await reviewRecords(projectDir)).map((record) => record.id)).toEqual([
    requested.reviewId,
  ]);
});

it("no subscriber → immediate no-reviewer; second concurrent review → 409 busy", async () => {
  const lonely = await requestReview({ prompt: "nobody is watching" });
  expect(lonely.status).toBe(200);
  expect(await body(lonely)).toEqual({ verdict: "no-reviewer", entries: [], durationMs: 0 });

  const stream = await openStream();
  const first = requestReview({ prompt: "first", timeoutSeconds: 5 });
  const { reviewId } = await stream.next("review-requested");

  const second = await requestReview({ prompt: "second", timeoutSeconds: 5 });
  expect(second.status).toBe(409);
  expect(await body(second)).toEqual({ ok: false, error: "busy" });

  // Busy is per project: another project's review is unaffected by this one.
  const elsewhere = await requestReview({ prompt: "other project", project: otherDir });
  expect(elsewhere.status).toBe(200);
  expect((await body(elsewhere)).verdict).toBe("no-reviewer");

  await postVerdict(reviewId, { verdict: "approved", entryIds: [] });
  expect((await body(await first)).verdict).toBe("approved");

  // …and the project is free again once the pending review resolves.
  const third = requestReview({ prompt: "third", timeoutSeconds: 5 });
  const next = await stream.next("review-requested", 2);
  expect(next.prompt).toBe("third");
  await postVerdict(next.reviewId, { verdict: "approved", entryIds: [] });
  expect((await body(await third)).verdict).toBe("approved");
});

it("timeoutSeconds elapses → {verdict:'timeout'} and review-cancelled on the stream", async () => {
  const stream = await openStream();
  const call = requestReview({ prompt: "waiting for nobody", timeoutSeconds: 0.2 });
  const { reviewId } = await stream.next("review-requested");

  const outcome = await body(await call);
  expect(outcome.verdict).toBe("timeout");
  expect(outcome.entries).toEqual([]);
  expect(outcome.durationMs).toBeGreaterThanOrEqual(150);

  expect(await stream.next("review-cancelled")).toEqual({ reviewId });

  // A timeout is an outcome, so it is in the audit trail by the time the agent
  // hears about it (docs/capture-format.md "Review session records").
  const records = await reviewRecords(projectDir);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    id: reviewId,
    prompt: "waiting for nobody",
    verdict: "timeout",
    entryIds: [],
  });
  expect(new Date(records[0]!.resolvedAt).toISOString()).toBe(records[0]!.resolvedAt);

  // The timed-out review is gone: its id no longer resolves, and the project is free.
  expect((await postVerdict(reviewId, { verdict: "approved", entryIds: [] })).status).toBe(404);
  const again = requestReview({ prompt: "second wind", timeoutSeconds: 0.2 });
  expect((await stream.next("review-requested", 2)).prompt).toBe("second wind");
  expect((await body(await again)).verdict).toBe("timeout");

  // A timeout too large for setTimeout must wait, not fire immediately.
  const patient = requestReview({ prompt: "all the time in the world", timeoutSeconds: 1e9 });
  const third = await stream.next("review-requested", 3);
  await postVerdict(third.reviewId, { verdict: "approved", entryIds: [] });
  expect((await body(await patient)).verdict).toBe("approved");
});

it("SSE connect while a review is pending replays review-requested", async () => {
  const first = await openStream();
  const call = requestReview({ prompt: "still pending", timeoutSeconds: 5 });
  const requested = await first.next("review-requested");

  // The page navigates or reloads: the stream drops and comes back.
  first.close();
  const second = await openStream();

  const replayed = await second.next("review-requested");
  expect(replayed).toEqual(requested);

  // The reconnected page can still answer — a disconnect never ends a review.
  await postVerdict(replayed.reviewId, { verdict: "changes", entryIds: [] });
  expect((await body(await call)).verdict).toBe("changes");
});

it("keeps the stream alive with comment-line heartbeats", async () => {
  const stream = await openStream();

  await waitFor(() => stream.comments.length >= 2, "two heartbeats");
  for (const comment of stream.comments) expect(comment.startsWith(":")).toBe(true);
  expect(stream.events).toEqual([]); // comments are not events
});

it("rejects malformed review requests and verdicts", async () => {
  const stream = await openStream();

  for (const bad of [
    {},
    { prompt: "   " },
    { prompt: 42 },
    { prompt: "ok", timeoutSeconds: 0 },
    { prompt: "ok", timeoutSeconds: -1 },
    { prompt: "ok", timeoutSeconds: "600" },
    { prompt: "ok", project: "relative/path" },
  ]) {
    const res = await requestReview(bad);
    expect(res.status, JSON.stringify(bad)).toBe(400);
    expect((await body(res)).ok).toBe(false);
  }

  const call = requestReview({ prompt: "real one", timeoutSeconds: 5 });
  const { reviewId } = await stream.next("review-requested");

  for (const bad of [
    {},
    { verdict: "timeout", entryIds: [] },
    { verdict: "approved" },
    { verdict: "approved", entryIds: "n1" },
    { verdict: "approved", entryIds: [1, 2] },
  ]) {
    const res = await postVerdict(reviewId, bad);
    expect(res.status, JSON.stringify(bad)).toBe(400);
    expect((await body(res)).ok).toBe(false);
  }

  // An unknown review id is a 404, and none of the above resolved the real one.
  expect((await postVerdict("nope", { verdict: "approved", entryIds: [] })).status).toBe(404);
  await postVerdict(reviewId, { verdict: "approved", entryIds: [] });
  expect((await body(await call)).verdict).toBe("approved");
});

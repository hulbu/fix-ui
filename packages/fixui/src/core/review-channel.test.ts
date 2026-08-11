import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Picker, ReviewVerdict } from "./picker.js";
import { connectReviewChannel } from "./review-channel.js";

const BRIDGE = "http://127.0.0.1:3499";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

const eventSourceImpl = FakeEventSource as unknown as typeof EventSource;

type FakePicker = Picker & { verdict(v: ReviewVerdict): void; unsubscribe: () => void };

function fakePicker(): FakePicker {
  let listener: ((v: ReviewVerdict) => void) | undefined;
  const unsubscribe = vi.fn();
  return {
    enable: vi.fn(),
    disable: vi.fn(),
    toggle: vi.fn(),
    destroy: vi.fn(),
    active: false,
    startReview: vi.fn(),
    endReview: vi.fn(),
    refresh: vi.fn(),
    onVerdict: vi.fn((cb: (v: ReviewVerdict) => void) => {
      listener = cb;
      return unsubscribe;
    }),
    verdict(v: ReviewVerdict) {
      listener?.(v);
    },
    unsubscribe,
  };
}

function okFetch() {
  return vi.fn<typeof fetch>(async () => ({ ok: true, status: 200 }) as Response);
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  FakeEventSource.instances.length = 0;
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("connectReviewChannel", () => {
  it("review-requested event → picker.startReview; verdict → POST /reviews/:id/verdict with {verdict,entryIds}", async () => {
    const picker = fakePicker();
    const fetchImpl = okFetch();
    connectReviewChannel({ bridgeUrl: BRIDGE, project: "/repo/app", picker, fetchImpl, eventSourceImpl });

    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe(`${BRIDGE}/events?project=%2Frepo%2Fapp`);

    source.emit("review-requested", { reviewId: "rev-1", prompt: "Review the new pricing table", timeoutSeconds: 600 });

    expect(picker.startReview).toHaveBeenCalledWith({
      reviewId: "rev-1",
      prompt: "Review the new pricing table",
      timeoutSeconds: 600,
    });

    picker.verdict({ reviewId: "rev-1", verdict: "changes", entryIds: ["e1", "e2"] });
    await settle();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BRIDGE}/reviews/rev-1/verdict`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ verdict: "changes", entryIds: ["e1", "e2"] });
  });

  it("review-cancelled → picker.endReview; close() closes the EventSource", () => {
    const picker = fakePicker();
    const channel = connectReviewChannel({ bridgeUrl: BRIDGE, picker, fetchImpl: okFetch(), eventSourceImpl });

    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe(`${BRIDGE}/events`);

    source.emit("review-cancelled", { reviewId: "rev-1" });
    expect(picker.endReview).toHaveBeenCalledTimes(1);

    channel.close();
    expect(source.closed).toBe(true);
    expect(picker.unsubscribe).toHaveBeenCalledTimes(1);

    // Nothing is delivered after close.
    source.emit("review-cancelled", { reviewId: "rev-2" });
    expect(picker.endReview).toHaveBeenCalledTimes(1);
  });

  /**
   * The bridge gates both halves of this channel on a token: any page the
   * developer visits can reach a loopback daemon, and a subscriber that learns
   * a reviewId can answer the review in the human's place. In the query string
   * on both, because `EventSource` cannot set headers.
   */
  it("carries the bridge token on the stream and on the verdict", async () => {
    const picker = fakePicker();
    const fetchImpl = okFetch();
    connectReviewChannel({
      bridgeUrl: BRIDGE,
      project: "/repo/app",
      token: "s3cret token",
      picker,
      fetchImpl,
      eventSourceImpl,
    });

    expect(FakeEventSource.instances[0]!.url).toBe(
      `${BRIDGE}/events?project=%2Frepo%2Fapp&token=s3cret+token`,
    );

    picker.verdict({ reviewId: "rev-1", verdict: "approved", entryIds: [] });
    await settle();
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      `${BRIDGE}/reviews/rev-1/verdict?token=s3cret%20token`,
    );
  });

  /**
   * A surface is one connected page (docs/agent-integration.md "Surfaces").
   * The page says what it is on the way in, and the bridge answers with the id
   * an agent aims at — the stream's first event.
   */
  it("describes the page on the stream url and keeps the surfaceId the bridge assigns", () => {
    const picker = fakePicker();
    const seen: string[] = [];
    const channel = connectReviewChannel({
      bridgeUrl: BRIDGE,
      project: "/repo/app",
      picker,
      fetchImpl: okFetch(),
      eventSourceImpl,
      describe: {
        origin: "http://localhost:4001",
        url: "http://localhost:4001/#pricing",
        title: "Pricing",
        label: "port 4001",
        adapter: "embed",
        windowId: 7,
        tabId: 42,
      },
      onSurface: (id) => seen.push(id),
    });

    const source = FakeEventSource.instances[0]!;
    const query = new URL(source.url).searchParams;
    expect(query.get("project")).toBe("/repo/app");
    expect(query.get("origin")).toBe("http://localhost:4001");
    expect(query.get("url")).toBe("http://localhost:4001/#pricing");
    expect(query.get("title")).toBe("Pricing");
    expect(query.get("label")).toBe("port 4001");
    expect(query.get("adapter")).toBe("embed");
    expect(query.get("windowId")).toBe("7");
    expect(query.get("tabId")).toBe("42");

    expect(channel.surfaceId).toBeUndefined();
    source.emit("surface", { surfaceId: "surface-1" });
    expect(channel.surfaceId).toBe("surface-1");
    expect(seen).toEqual(["surface-1"]);

    // A malformed handshake changes nothing that was already agreed.
    source.emit("surface", { surfaceId: 42 });
    expect(channel.surfaceId).toBe("surface-1");
  });

  /** An older bridge sends no `surface` event at all; the channel still works. */
  it("omits absent describe fields and survives a bridge that assigns no surface", () => {
    const picker = fakePicker();
    const channel = connectReviewChannel({
      bridgeUrl: BRIDGE,
      picker,
      fetchImpl: okFetch(),
      eventSourceImpl,
      describe: { label: "  ", title: "Only this" },
    });

    expect(FakeEventSource.instances[0]!.url).toBe(`${BRIDGE}/events?title=Only+this`);
    expect(channel.surfaceId).toBeUndefined();

    FakeEventSource.instances[0]!.emit("review-requested", { reviewId: "r1", prompt: "look" });
    expect(picker.startReview).toHaveBeenCalledTimes(1);
  });

  /**
   * The reported bug: the count only moved when the panel was opened, so an
   * agent clearing entries left a stale number on the chip. The bridge says
   * `inbox-changed`; the page answers by re-reading, whether or not anything is
   * open — and a burst of them (five `resolve_feedback` calls in a row) is one
   * re-read, not five.
   */
  it("inbox-changed refreshes the picker, and a burst of them refreshes once", async () => {
    vi.useFakeTimers();
    try {
      const picker = fakePicker();
      connectReviewChannel({ bridgeUrl: BRIDGE, picker, fetchImpl: okFetch(), eventSourceImpl });
      const source = FakeEventSource.instances[0]!;

      for (let n = 0; n < 5; n += 1) source.emit("inbox-changed", { project: "/repo/app" });
      expect(picker.refresh).not.toHaveBeenCalled(); // coalesced, never eager

      await vi.advanceTimersByTimeAsync(500);
      expect(picker.refresh).toHaveBeenCalledTimes(1);

      // A change after the window is its own refresh — coalescing is not a rate
      // limit that swallows the next one.
      source.emit("inbox-changed", {});
      await vi.advanceTimersByTimeAsync(500);
      expect(picker.refresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a pending refresh is dropped when the channel closes", async () => {
    vi.useFakeTimers();
    try {
      const picker = fakePicker();
      const channel = connectReviewChannel({
        bridgeUrl: BRIDGE,
        picker,
        fetchImpl: okFetch(),
        eventSourceImpl,
      });
      const source = FakeEventSource.instances[0]!;

      source.emit("inbox-changed", {});
      channel.close();
      await vi.advanceTimersByTimeAsync(500);

      expect(picker.refresh).not.toHaveBeenCalled();
      source.emit("inbox-changed", {});
      await vi.advanceTimersByTimeAsync(500);
      expect(picker.refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  /** A session is the same channel asking a different question: the mode travels
   *  on `review-requested`, and the verdict travels back the same way. */
  it("carries a session's mode to the picker and its submitted verdict back", async () => {
    const picker = fakePicker();
    const fetchImpl = okFetch();
    connectReviewChannel({ bridgeUrl: BRIDGE, picker, fetchImpl, eventSourceImpl });
    const source = FakeEventSource.instances[0]!;

    source.emit("review-requested", { reviewId: "ses-1", prompt: "Fix what you see", mode: "session" });
    expect(picker.startReview).toHaveBeenCalledWith({
      reviewId: "ses-1",
      prompt: "Fix what you see",
      mode: "session",
    });

    // An unknown mode is not a mode: an older page would ignore it, and a newer
    // bridge must not be able to talk this one into a mode it cannot answer.
    source.emit("review-requested", { reviewId: "rev-2", prompt: "plain", mode: "whatever" });
    expect(picker.startReview).toHaveBeenLastCalledWith({ reviewId: "rev-2", prompt: "plain" });

    // A session carries no prompt at all now — its panel says a fixed line, and
    // the agent's account of the batch goes to the terminal. So the channel must
    // pass one through without inventing a prompt for it…
    source.emit("review-requested", { reviewId: "ses-2", mode: "session" });
    expect(picker.startReview).toHaveBeenLastCalledWith({ reviewId: "ses-2", mode: "session" });

    // …while a review with no prompt is still a question with no question in
    // it: unanswerable on the page, so it is not raised.
    source.emit("review-requested", { reviewId: "rev-3" });
    expect(picker.startReview).toHaveBeenLastCalledWith({ reviewId: "ses-2", mode: "session" });

    picker.verdict({ reviewId: "ses-1", verdict: "submitted", entryIds: ["e1"] });
    await settle();
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual({
      verdict: "submitted",
      entryIds: ["e1"],
    });
  });

  it("navigates by hash when only the fragment differs and ignores cross-origin urls", () => {
    const picker = fakePicker();
    connectReviewChannel({ bridgeUrl: `${BRIDGE}/`, picker, fetchImpl: okFetch(), eventSourceImpl });
    const source = FakeEventSource.instances[0]!;
    const before = location.href;

    source.emit("review-requested", { reviewId: "rev-1", prompt: "hero", url: `${location.origin}/#pricing` });
    expect(location.hash).toBe("#pricing");

    source.emit("review-requested", { reviewId: "rev-2", prompt: "hero", url: "https://example.com/other" });
    expect(location.href).toBe(`${before}#pricing`);
    expect(picker.startReview).toHaveBeenCalledTimes(2);
  });
});

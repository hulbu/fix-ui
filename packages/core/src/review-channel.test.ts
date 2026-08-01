import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Picker, ReviewVerdict } from "./picker";
import { connectReviewChannel } from "./review-channel";

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

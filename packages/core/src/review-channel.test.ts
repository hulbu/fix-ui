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

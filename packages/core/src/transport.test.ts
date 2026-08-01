import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeedbackEntry } from "./entry";
import { createTransport, type Transport, type TransportOptions } from "./transport";

const QUEUE_KEY = "fixui.queue.v1";
const ENDPOINT = "http://127.0.0.1:3499/entries";

function makeEntry(over: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    v: 1,
    id: "entry-1",
    note: "make this button bigger",
    selector: "#cta",
    url: "http://localhost:4001/",
    viewport: { width: 800, height: 600 },
    userAgent: "UA",
    createdAt: "2026-07-31T09:00:00.000Z",
    ...over,
  };
}

function createFakeStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key: string): string | null => data.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      data.set(key, value);
    },
    removeItem: (key: string): void => {
      data.delete(key);
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function okFetch(body: unknown = { ok: true }) {
  return vi.fn<typeof fetch>(async () => jsonResponse(body));
}

function failingFetch() {
  return vi.fn<typeof fetch>(async () => {
    throw new TypeError("Failed to fetch");
  });
}

function bodyOf(call: [input: RequestInfo | URL, init?: RequestInit]): Record<string, unknown> {
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
}

describe("createTransport", () => {
  const live: Transport[] = [];
  const make = (opts: TransportOptions): Transport => {
    const transport = createTransport(opts);
    live.push(transport);
    return transport;
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    while (live.length > 0) live.pop()!.destroy();
    vi.useRealTimers();
    localStorage.clear();
  });

  it("POSTs entry to endpoint and resolves {ok:true,queued:false} on 200", async () => {
    const fetchImpl = okFetch();
    const storage = createFakeStorage();
    const entry = makeEntry();
    const transport = make({ endpoint: ENDPOINT, fetchImpl, storage });

    await expect(transport.create(entry)).resolves.toEqual({ ok: true, queued: false });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual(entry);
    expect(storage.data.size).toBe(0);
  });

  it("queues on network failure, persists to storage, and flushes successfully later", async () => {
    const fetchImpl = failingFetch();
    const storage = createFakeStorage();
    const onQueueChange = vi.fn();
    const entry = makeEntry();
    const transport = make({ endpoint: ENDPOINT, fetchImpl, storage, onQueueChange });

    await expect(transport.create(entry)).resolves.toEqual({ ok: false, queued: true });
    expect(onQueueChange).toHaveBeenLastCalledWith(1);
    expect(JSON.parse(storage.getItem(QUEUE_KEY)!)).toEqual([entry]);

    fetchImpl.mockImplementation(async () => jsonResponse({ ok: true }));
    await transport.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchImpl.mock.calls[1]!)).toEqual(entry);
    expect(storage.getItem(QUEUE_KEY)).toBeNull();
    expect(onQueueChange).toHaveBeenLastCalledWith(0);
  });

  it("queues when the endpoint answers a non-2xx status", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ ok: false, error: "unwritable" }, 500));
    const storage = createFakeStorage();
    const transport = make({ endpoint: ENDPOINT, fetchImpl, storage });

    await expect(transport.create(makeEntry())).resolves.toEqual({ ok: false, queued: true });
    expect(JSON.parse(storage.getItem(QUEUE_KEY)!)).toHaveLength(1);
  });

  it("retries the queue with exponential backoff 1s, 2s, 4s … capped at 30s", async () => {
    const fetchImpl = failingFetch();
    const storage = createFakeStorage();
    // No clipboard configured — there is no last resort, so the entry stays queued.
    const transport = make({ endpoint: ENDPOINT, fetchImpl, storage });

    await transport.create(makeEntry());
    let calls = 1;
    expect(fetchImpl).toHaveBeenCalledTimes(calls);

    for (const delay of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetchImpl).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      calls += 1;
      expect(fetchImpl).toHaveBeenCalledTimes(calls);
    }

    expect(JSON.parse(storage.getItem(QUEUE_KEY)!)).toHaveLength(1);
  });

  it("falls back to clipboard after 5 failed flush attempts for an entry", async () => {
    const fetchImpl = failingFetch();
    const clipboard = vi.fn<(text: string) => Promise<void>>(async () => {});
    const onQueueChange = vi.fn();
    const storage = createFakeStorage();
    const entry = makeEntry();
    const transport = make({ endpoint: ENDPOINT, fetchImpl, storage, clipboard, onQueueChange });

    await transport.create(entry);
    expect(onQueueChange).toHaveBeenLastCalledWith(1);

    for (let i = 0; i < 4; i += 1) await transport.flush();
    expect(clipboard).not.toHaveBeenCalled();
    expect(JSON.parse(storage.getItem(QUEUE_KEY)!)).toHaveLength(1);

    await transport.flush();

    expect(clipboard).toHaveBeenCalledTimes(1);
    expect(clipboard).toHaveBeenCalledWith(JSON.stringify(entry));
    expect(storage.getItem(QUEUE_KEY)).toBeNull();
    expect(onQueueChange).toHaveBeenLastCalledWith(0);

    await transport.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(6); // nothing left to send
  });

  it("copies every entry expiring in the same round as one JSONL clipboard payload", async () => {
    const a = makeEntry({ id: "a" });
    const b = makeEntry({ id: "b" });
    const storage = createFakeStorage({ [QUEUE_KEY]: JSON.stringify([a, b]) });
    const fetchImpl = failingFetch();
    const clipboard = vi.fn<(text: string) => Promise<void>>(async () => {});
    const onQueueChange = vi.fn();
    const transport = make({ endpoint: ENDPOINT, fetchImpl, storage, clipboard, onQueueChange });

    // Both entries start at zero attempts, so they cross the limit in the same round.
    for (let i = 0; i < 5; i += 1) await transport.flush();

    expect(clipboard).toHaveBeenCalledTimes(1);
    const payload = clipboard.mock.calls[0]![0];
    expect(payload.split("\n").map((line) => JSON.parse(line))).toEqual([a, b]);
    expect(storage.getItem(QUEUE_KEY)).toBeNull();
    expect(onQueueChange).toHaveBeenLastCalledWith(0);
  });

  it("keeps entries queued when the clipboard write is refused", async () => {
    const fetchImpl = failingFetch();
    const clipboard = vi.fn<(text: string) => Promise<void>>(async () => {
      throw new Error("clipboard needs user activation");
    });
    const storage = createFakeStorage();
    const transport = make({ endpoint: ENDPOINT, fetchImpl, storage, clipboard });

    await transport.create(makeEntry());
    for (let i = 0; i < 5; i += 1) await transport.flush();

    expect(clipboard).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.getItem(QUEUE_KEY)!)).toHaveLength(1);
  });

  it("rejects a malformed entry without posting or queuing it", async () => {
    const fetchImpl = okFetch();
    const storage = createFakeStorage();
    const onQueueChange = vi.fn();
    const transport = make({ endpoint: ENDPOINT, fetchImpl, storage, onQueueChange });

    const malformed = makeEntry({ elementText: "x".repeat(200) });
    await expect(transport.create(malformed)).resolves.toEqual({ ok: false, queued: false });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(storage.getItem(QUEUE_KEY)).toBeNull();
    expect(onQueueChange).not.toHaveBeenCalled();

    // …and the same entry within the caps goes through normally.
    await expect(transport.create(makeEntry({ elementText: "Continue" }))).resolves.toEqual({
      ok: true,
      queued: false,
    });
  });

  it("remove(id) sends DELETE with {id} body and returns true on {ok:true}", async () => {
    const fetchImpl = okFetch({ ok: true });
    const transport = make({ endpoint: ENDPOINT, fetchImpl, storage: createFakeStorage() });

    await expect(transport.remove("entry-1")).resolves.toBe(true);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect(init?.method).toBe("DELETE");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ id: "entry-1" });

    fetchImpl.mockImplementationOnce(async () => jsonResponse({ ok: false }, 400));
    await expect(transport.remove("entry-1")).resolves.toBe(false);

    fetchImpl.mockImplementationOnce(async () => jsonResponse({ ok: false }));
    await expect(transport.remove("entry-1")).resolves.toBe(false);

    fetchImpl.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(transport.remove("entry-1")).resolves.toBe(false);
  });

  it("list() GETs the endpoint and returns [] on network failure", async () => {
    const entry = makeEntry();
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ entries: [entry] }));
    const transport = make({ endpoint: ENDPOINT, fetchImpl, storage: createFakeStorage() });

    await expect(transport.list()).resolves.toEqual([entry]);
    expect(fetchImpl.mock.calls[0]![0]).toBe(ENDPOINT);
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe("GET");
    expect(fetchImpl.mock.calls[0]![1]?.headers).toBeUndefined(); // no needless CORS preflight

    fetchImpl.mockImplementationOnce(async () => jsonResponse([entry]));
    await expect(transport.list()).resolves.toEqual([entry]);

    fetchImpl.mockImplementationOnce(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(transport.list()).resolves.toEqual([]);

    fetchImpl.mockImplementationOnce(async () => jsonResponse({ ok: false }, 500));
    await expect(transport.list()).resolves.toEqual([]);

    fetchImpl.mockImplementationOnce(async () => jsonResponse("nonsense"));
    await expect(transport.list()).resolves.toEqual([]);
  });

  it("stamps project onto entries when configured", async () => {
    const fetchImpl = okFetch();
    const transport = make({
      endpoint: ENDPOINT,
      project: "/Users/me/app",
      fetchImpl,
      storage: createFakeStorage(),
    });

    await transport.create(makeEntry());
    expect(bodyOf(fetchImpl.mock.calls[0]!).project).toBe("/Users/me/app");

    await transport.create(makeEntry({ id: "entry-2", project: "/Users/me/other" }));
    expect(bodyOf(fetchImpl.mock.calls[1]!).project).toBe("/Users/me/other");
  });

  it("carries project on list() and remove() so reads and deletes hit the same inbox", async () => {
    const fetchImpl = okFetch();
    const transport = make({
      endpoint: ENDPOINT,
      project: "/Users/me/my app",
      fetchImpl,
      storage: createFakeStorage(),
    });

    await transport.list();
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${ENDPOINT}?project=%2FUsers%2Fme%2Fmy%20app`);
    expect(fetchImpl.mock.calls[0]![1]?.headers).toBeUndefined(); // still no preflight

    await transport.remove("entry-1");
    expect(bodyOf(fetchImpl.mock.calls[1]!)).toEqual({
      id: "entry-1",
      project: "/Users/me/my app",
    });
  });

  it("leaves list() and remove() unqualified when no project is configured", async () => {
    const fetchImpl = okFetch({ entries: [] });
    const transport = make({ endpoint: ENDPOINT, fetchImpl, storage: createFakeStorage() });

    await transport.list();
    expect(fetchImpl.mock.calls[0]![0]).toBe(ENDPOINT);

    await transport.remove("entry-1");
    expect(bodyOf(fetchImpl.mock.calls[1]!)).toEqual({ id: "entry-1" });
  });

  it("restores the queue from storage on construction, deduping by id", async () => {
    const a = makeEntry({ id: "a" });
    const b = makeEntry({ id: "b" });
    const storage = createFakeStorage({
      [QUEUE_KEY]: JSON.stringify([a, a, b, { id: "malformed" }, "junk"]),
    });
    const fetchImpl = okFetch();
    const onQueueChange = vi.fn();
    const transport = make({ endpoint: ENDPOINT, fetchImpl, storage, onQueueChange });

    expect(onQueueChange).toHaveBeenCalledWith(2);

    await transport.flush();

    expect(fetchImpl.mock.calls.map((call) => bodyOf(call).id)).toEqual(["a", "b"]);
    expect(storage.getItem(QUEUE_KEY)).toBeNull();
    expect(onQueueChange).toHaveBeenLastCalledWith(0);
  });

  it("ignores an unreadable stored queue", async () => {
    const fetchImpl = okFetch();
    const transport = make({
      endpoint: ENDPOINT,
      fetchImpl,
      storage: createFakeStorage({ [QUEUE_KEY]: "{not json" }),
    });

    await transport.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("destroy() cancels pending retries", async () => {
    const fetchImpl = failingFetch();
    const transport = make({ endpoint: ENDPOINT, fetchImpl, storage: createFakeStorage() });

    await transport.create(makeEntry());
    transport.destroy();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("persists the queue to localStorage when no storage is injected", async () => {
    const fetchImpl = failingFetch();
    const entry = makeEntry();
    const transport = make({ endpoint: ENDPOINT, fetchImpl });

    await transport.create(entry);

    expect(JSON.parse(localStorage.getItem(QUEUE_KEY)!)).toEqual([entry]);
  });
});

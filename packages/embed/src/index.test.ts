import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initFixUi, type FixUiInternals, type FixUiOptions } from "./index";

const NS = "data-uifb";
const DEFAULT_BRIDGE = "http://127.0.0.1:3499";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  closes = 0;

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
    this.closes += 1;
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

const eventSourceImpl = FakeEventSource as unknown as typeof EventSource;

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function recordingFetch({ fail = false } = {}) {
  const calls: FetchCall[] = [];
  const impl = vi.fn<typeof fetch>(async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>),
    });
    if (fail) throw new TypeError("Failed to fetch");
    return { ok: true, status: 200, json: async () => [] } as unknown as Response;
  });
  return Object.assign(impl, {
    calls,
    posts: (): FetchCall[] => calls.filter((call) => call.method === "POST"),
  });
}

function fakeStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

/** Quiet: the console buffer calls through to whatever it wrapped. */
function silentConsoleError() {
  return vi.spyOn(window.console, "error").mockImplementation(() => {});
}

/** Every async path here is microtasks — this settles under fake timers too. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** The whole pointer sequence a real click produces. */
function clickSequence(el: Element): void {
  for (const type of ["pointerdown", "mousedown", "mouseup", "pointerup", "click"]) {
    el.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: 5, clientY: 5 }),
    );
  }
}

async function pickAndSave(ui: { enable(): void }, note: string): Promise<void> {
  ui.enable();
  clickSequence(document.querySelector("#cta")!);
  const pop = document.querySelector(`[${NS}-pop]`)!;
  const textarea = pop.querySelector("textarea")!;
  textarea.value = note;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  pop.querySelector<HTMLButtonElement>(`[${NS}-save]`)!.click();
  await settle();
}

const live: Array<{ close(): void }> = [];
function init(options: FixUiOptions = {}, internals: FixUiInternals = {}) {
  const ui = initFixUi(options, { storage: fakeStorage(), ...internals });
  live.push(ui);
  return ui;
}

beforeEach(() => {
  document.body.innerHTML = `<button id="cta">Continue</button>`;
});

afterEach(() => {
  while (live.length > 0) live.pop()!.close();
  FakeEventSource.instances.length = 0;
  document.body.innerHTML = "";
  document.body.style.cursor = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("initFixUi", () => {
  it("mounts the picker chip and installs console capture at init", async () => {
    const original = silentConsoleError();

    init({}, { fetchImpl: recordingFetch() });
    await settle();

    expect(document.querySelector(`[${NS}-chip]`)).not.toBeNull();
    expect(window.console.error).not.toBe(original); // wrapped by the buffer
  });

  it("carries console errors from before the note was written into the saved entry", async () => {
    silentConsoleError();
    const fetchImpl = recordingFetch();
    const ui = init({}, { fetchImpl });
    await settle();

    window.console.error("TypeError: cart.total is not a function");
    await pickAndSave(ui, "this button does nothing");

    const entry = fetchImpl.posts()[0]?.body;
    expect(entry).toMatchObject({ note: "this button does nothing", selector: "#cta" });
    expect(entry?.consoleErrors).toMatchObject([{ message: "TypeError: cart.total is not a function", count: 1 }]);
  });

  it("defaults to the local bridge for both the inbox and the review channel", async () => {
    const fetchImpl = recordingFetch();
    const ui = init({ project: "/repo" }, { fetchImpl, eventSourceImpl });
    await settle();

    expect(FakeEventSource.instances.map((source) => source.url)).toEqual([
      `${DEFAULT_BRIDGE}/events?project=%2Frepo`,
    ]);

    await pickAndSave(ui, "make this bigger");
    expect(fetchImpl.posts()[0]).toMatchObject({ url: `${DEFAULT_BRIDGE}/entries` });
    expect(fetchImpl.posts()[0]?.body).toMatchObject({ project: "/repo" });
  });

  it("routes both the inbox and the review channel at an explicit bridgeUrl", async () => {
    const fetchImpl = recordingFetch();
    const ui = init({ bridgeUrl: "http://127.0.0.1:4000" }, { fetchImpl, eventSourceImpl });
    await settle();

    expect(FakeEventSource.instances[0]?.url).toBe("http://127.0.0.1:4000/events");
    await pickAndSave(ui, "make this bigger");
    expect(fetchImpl.posts()[0]?.url).toBe("http://127.0.0.1:4000/entries");
  });

  it("is bridge-less with a custom endpoint: posts there and opens no review channel", async () => {
    const fetchImpl = recordingFetch();
    const ui = init({ endpoint: "/api/ui-feedback" }, { fetchImpl, eventSourceImpl });
    await settle();

    expect(FakeEventSource.instances).toHaveLength(0);
    await pickAndSave(ui, "make this bigger");
    expect(fetchImpl.posts()[0]?.url).toBe("/api/ui-feedback");
  });

  it("keeps the review channel when a custom endpoint names a bridgeUrl too", async () => {
    const fetchImpl = recordingFetch();
    const ui = init(
      { endpoint: "/api/ui-feedback", bridgeUrl: DEFAULT_BRIDGE },
      { fetchImpl, eventSourceImpl },
    );
    await settle();

    expect(FakeEventSource.instances[0]?.url).toBe(`${DEFAULT_BRIDGE}/events`);
    await pickAndSave(ui, "make this bigger");
    expect(fetchImpl.posts()[0]?.url).toBe("/api/ui-feedback");
  });

  it("skips the review channel where the browser has no EventSource", async () => {
    expect(globalThis.EventSource).toBeUndefined(); // jsdom, and old browsers

    const fetchImpl = recordingFetch();
    const ui = init({}, { fetchImpl });
    await settle();

    expect(document.querySelector(`[${NS}-chip]`)).not.toBeNull();
    await pickAndSave(ui, "still works without SSE");
    expect(fetchImpl.posts()[0]?.url).toBe(`${DEFAULT_BRIDGE}/entries`);
  });

  it("runs the agent-initiated review: SSE request in, verdict POSTed back", async () => {
    const fetchImpl = recordingFetch();
    init({}, { fetchImpl, eventSourceImpl });
    await settle();

    FakeEventSource.instances[0]!.emit("review-requested", {
      reviewId: "rev-1",
      prompt: "Does the header look right now?",
    });

    expect(document.querySelector(`[${NS}-banner]`)?.textContent).toContain("Does the header look right now?");
    document.querySelector<HTMLButtonElement>(`[${NS}-approve]`)!.click();
    await settle();

    const verdict = fetchImpl.calls.find((call) => call.url.includes("/reviews/"));
    expect(verdict).toMatchObject({ url: `${DEFAULT_BRIDGE}/reviews/rev-1/verdict`, method: "POST" });
    expect(verdict?.body).toEqual({ verdict: "approved", entryIds: [] });
  });

  it("hands the browser clipboard to the transport as the last resort", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async (_text: string) => {});
    // Core takes no clipboard of its own — jsdom has none either, so every
    // other test here runs the "omit it and keep retrying" branch.
    vi.stubGlobal("navigator", { userAgent: "vitest", clipboard: { writeText } });
    const fetchImpl = recordingFetch({ fail: true });
    const ui = init({}, { fetchImpl });
    await settle();

    await pickAndSave(ui, "nobody is listening on 3499");
    await vi.advanceTimersByTimeAsync(60_000); // five failed rounds of backoff

    expect(writeText).toHaveBeenCalledOnce();
    expect(JSON.parse(writeText.mock.calls[0]![0])).toMatchObject({
      note: "nobody is listening on 3499",
    });
  });

  it("exposes the live picker surface — `active` is not a snapshot", async () => {
    const ui = init({}, { fetchImpl: recordingFetch() });
    await settle();

    expect(ui.active).toBe(false);
    ui.enable();
    expect(ui.active).toBe(true);
    ui.toggle();
    expect(ui.active).toBe(false);
  });

  it("close() removes the UI, restores console.error, closes the channel and stops transport retries", async () => {
    vi.useFakeTimers();
    const original = silentConsoleError();
    const fetchImpl = recordingFetch({ fail: true });
    const ui = init({}, { fetchImpl, eventSourceImpl });
    await settle();
    await pickAndSave(ui, "queued while the bridge is down");
    expect(document.querySelector(`[${NS}-chip]`)).not.toBeNull();

    ui.close();

    expect(document.querySelector(`[${NS}-chip]`)).toBeNull();
    expect(document.querySelector(`[${NS}-box]`)).toBeNull();
    expect(window.console.error).toBe(original);
    expect(FakeEventSource.instances[0]?.closes).toBe(1);

    const delivered = fetchImpl.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl.calls.length).toBe(delivered); // the retry timer went with it
  });

  it("close() is idempotent", async () => {
    const ui = init({}, { fetchImpl: recordingFetch(), eventSourceImpl });
    await settle();

    ui.close();
    expect(() => ui.close()).not.toThrow();
    expect(FakeEventSource.instances[0]?.closes).toBe(1);
  });
});

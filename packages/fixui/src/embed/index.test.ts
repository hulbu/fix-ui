import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initFixUi, type FixUiInternals, type FixUiOptions } from "./index.js";

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

/**
 * An event the browser itself would have produced. Core refuses to save a note
 * or answer a review on anything script synthesized (`isTrusted`), which is
 * exactly the point — so a test standing in for a human reaches past the
 * wrapper to jsdom's own event object, where the flag is an ordinary field.
 * The getter also has to swallow the write `dispatchEvent()` is specified to
 * make on its way through.
 */
function trusted<E extends Event>(event: E): E {
  for (const symbol of Object.getOwnPropertySymbols(event)) {
    const impl = (event as unknown as Record<symbol, object>)[symbol];
    if (!impl || typeof impl !== "object" || !("isTrusted" in impl)) continue;
    Object.defineProperty(impl, "isTrusted", {
      get: () => true,
      set: () => undefined,
      configurable: true,
    });
  }
  if (!event.isTrusted) throw new Error("could not forge isTrusted — jsdom internals moved");
  return event;
}

function humanClick(el: Element): void {
  el.dispatchEvent(trusted(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

/** The whole pointer sequence a real click produces. */
function clickSequence(el: Element): void {
  for (const type of ["pointerdown", "mousedown", "mouseup", "pointerup", "click"]) {
    el.dispatchEvent(
      trusted(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: 5,
          clientY: 5,
        }),
      ),
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
  humanClick(pop.querySelector<HTMLButtonElement>(`[${NS}-save]`)!);
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
  vi.unstubAllGlobals(); // the clipboard test stubs `navigator` — don't leak it
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

    // One stream, at the default bridge, routed on this project. (It carries
    // the page description too — see the surfaces test below.)
    expect(FakeEventSource.instances).toHaveLength(1);
    const stream = new URL(FakeEventSource.instances[0]!.url);
    expect(`${stream.origin}${stream.pathname}`).toBe(`${DEFAULT_BRIDGE}/events`);
    expect(stream.searchParams.get("project")).toBe("/repo");

    await pickAndSave(ui, "make this bigger");
    expect(fetchImpl.posts()[0]).toMatchObject({ url: `${DEFAULT_BRIDGE}/entries` });
    expect(fetchImpl.posts()[0]?.body).toMatchObject({ project: "/repo" });
  });

  it("routes both the inbox and the review channel at an explicit bridgeUrl", async () => {
    const fetchImpl = recordingFetch();
    const ui = init({ bridgeUrl: "http://127.0.0.1:4000" }, { fetchImpl, eventSourceImpl });
    await settle();

    expect(FakeEventSource.instances[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:4000\/events\?/);
    await pickAndSave(ui, "make this bigger");
    expect(fetchImpl.posts()[0]?.url).toBe("http://127.0.0.1:4000/entries");
  });

  /**
   * The bridge gates its review channel; a page cannot read `.fix-ui.json`, so
   * a dev build has to be handed the token explicitly. Without one the notes
   * half still works and the review half is 401 — the bridge-less experience.
   */
  it("passes a review token through to the channel", async () => {
    const fetchImpl = recordingFetch();
    init({ project: "/repo", token: "tok-123" }, { fetchImpl, eventSourceImpl });
    await settle();

    const gated = new URL(FakeEventSource.instances[0]!.url).searchParams;
    expect(gated.get("project")).toBe("/repo");
    expect(gated.get("token")).toBe("tok-123");

    FakeEventSource.instances[0]!.emit("review-requested", { reviewId: "rev-1", prompt: "look" });
    humanClick(document.querySelector<HTMLButtonElement>(`[${NS}-approve]`)!);
    await settle();

    expect(fetchImpl.calls.find((call) => call.url.includes("/reviews/"))?.url).toBe(
      `${DEFAULT_BRIDGE}/reviews/rev-1/verdict?token=tok-123`,
    );
  });

  /**
   * A surface is one connected page (docs/agent-integration.md "Surfaces").
   * The embed knows what page it is on, so it says so without being asked;
   * `label` is the developer's own name for this one — "staging", "port 4001".
   */
  it("describes the page it runs on, and exposes the surfaceId the bridge assigns", async () => {
    const fetchImpl = recordingFetch();
    const ui = init({ project: "/repo", label: "port 4001" }, { fetchImpl, eventSourceImpl });
    await settle();

    const query = new URL(FakeEventSource.instances[0]!.url).searchParams;
    expect(query.get("project")).toBe("/repo");
    expect(query.get("label")).toBe("port 4001");
    expect(query.get("origin")).toBe(location.origin);
    expect(query.get("url")).toBe(location.href);
    expect(query.get("adapter")).toBe("embed");
    expect(query.get("title")).toBe(document.title === "" ? null : document.title);

    expect(ui.surfaceId).toBeUndefined();
    FakeEventSource.instances[0]!.emit("surface", { surfaceId: "surface-9" });
    expect(ui.surfaceId).toBe("surface-9");
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

    expect(FakeEventSource.instances[0]?.url).toMatch(new RegExp(`^${DEFAULT_BRIDGE}/events\\?`));
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

    // The request lands in the notes panel, which opens itself to carry it.
    const panel = document.querySelector(`[${NS}-panel]`)!;
    expect(panel.querySelector(`[${NS}-agent]`)?.textContent).toContain(
      "Does the header look right now?",
    );
    humanClick(panel.querySelector<HTMLButtonElement>(`[${NS}-approve]`)!);
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

  /**
   * The reported "I lost all comments", through the whole embed rather than one
   * seam of it: one storage, two `initFixUi` calls, and the bridge down for both
   * — which is exactly the situation the report came from.
   */
  it("brings notes queued before a reload back into the panel and the badge", async () => {
    const storage = fakeStorage();
    const fetchImpl = recordingFetch({ fail: true });

    const before = init({}, { fetchImpl, storage });
    await settle();
    await pickAndSave(before, "the bridge was not running when I wrote this");
    expect(document.querySelector(`[${NS}-badge]`)!.textContent).toBe("1");
    // The page goes away. Nothing in picker memory survives this.
    before.close();
    live.pop();
    expect(document.querySelector(`[${NS}-badge]`)).toBeNull();

    // …and comes back, over the same storage, with the same dead bridge.
    init({}, { fetchImpl, storage });
    await settle();

    expect(document.querySelector(`[${NS}-badge]`)!.textContent).toBe("1");
    document.querySelector<HTMLButtonElement>(`[${NS}-chip]`)!.click();
    await settle();
    const row = document.querySelector(`[${NS}-row]`)!;
    expect(row.textContent).toContain("the bridge was not running when I wrote this");
    expect(row.hasAttribute(`${NS}-queued`)).toBe(true);
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

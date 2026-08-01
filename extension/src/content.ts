import {
  createConsoleBuffer,
  createPicker,
  createTransport,
  type Picker,
  type ReviewVerdict,
  type Transport,
} from "@hulbu/fixui-core";
import {
  CAPTURE_TOGGLE,
  COMPONENT_QUERY,
  CONFIG_MESSAGE,
  CONTENT_SOURCE,
  PROBE_ATTRIBUTE,
  REVIEW_CANCELLED_MESSAGE,
  REVIEW_REQUESTED_MESSAGE,
  TOGGLE_OFF_MESSAGE,
  decodeFetchResponse,
  encodeFetchRequest,
  parseMainMessage,
  type ReviewRequestMessage,
} from "./protocol";

/**
 * The content script: core's picker, mounted in a CLOSED shadow root so the
 * page's CSS cannot touch the UI and the page's JavaScript cannot reach into
 * it. Injected on demand (the toolbar action) — nothing here runs on a page you
 * did not activate.
 *
 * Two boundaries meet in this file, and both are one-way distrustful:
 *   - the MAIN world (page reality) posts console errors and component names
 *     in; every payload is validated by `parseMainMessage` before it is used,
 *   - the service worker does all bridge IO, because a content script on an
 *     https page is blocked from fetching http://127.0.0.1 by mixed content.
 */
const INSTALLED = "__fixuiContent";
/** How long a component-name query may stay unanswered before the next one may go. */
const QUERY_TIMEOUT_MS = 1000;

interface ContentConfig {
  bridgeUrl: string;
  project?: string;
  /** A review the bridge already announced — replayed to a fresh content script. */
  review?: ReviewRequestMessage;
}

function install(): void {
  const buffer = createConsoleBuffer();
  /** Component names arrive a tick after they are first asked for; by the time
   *  a note is saved (seconds later) the answer is here. */
  const names = new WeakMap<Element, string>();
  let pending: { token: number; el: Element; at: number } | null = null;
  let queries = 0;

  let picker: Picker | null = null;
  let transport: Transport | null = null;
  let unsubscribe: (() => void) | null = null;
  let host: HTMLElement | null = null;
  let queuedReview: ReviewRequestMessage | null = null;
  let bridgeUrl = "";
  let torn = false;

  // --- bridge IO, proxied through the service worker -----------------------
  const bridgeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const raw: unknown = await chrome.runtime.sendMessage(encodeFetchRequest(url, init));
    const { status, statusText, body } = decodeFetchResponse(raw);
    // `new Response(body)` throws for the null-body statuses; core only reads
    // `ok`/`json()` anyway, and a rejected fetch would look like a dead bridge.
    const empty = status === 204 || status === 205 || status === 304;
    return new Response(empty ? null : body, { status, statusText });
  }) as typeof fetch;

  /**
   * Core's last resort when the bridge stays unreachable. It has to come from
   * here rather than from the service worker: the clipboard needs the page's
   * user-gesture context. Omitted where the browser has none, so the transport
   * keeps retrying instead of "delivering" notes to a clipboard that isn't there.
   */
  const clipboard =
    typeof navigator !== "undefined" && navigator.clipboard
      ? (text: string): Promise<void> => navigator.clipboard.writeText(text)
      : undefined;

  async function postVerdict(verdict: ReviewVerdict): Promise<void> {
    try {
      await bridgeFetch(`${bridgeUrl}/reviews/${encodeURIComponent(verdict.reviewId)}/verdict`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict: verdict.verdict, entryIds: verdict.entryIds }),
      });
    } catch {
      // Bridge gone — the held tool call times out agent-side, which is a
      // first-class verdict there. Nothing useful to retry against.
    }
  }

  // --- MAIN world ----------------------------------------------------------
  function toMainWorld(payload: Record<string, unknown>): void {
    try {
      window.postMessage({ source: CONTENT_SOURCE, ...payload }, "*");
    } catch {
      // Page broke postMessage; picking still works, capture doesn't.
    }
  }

  function clearProbe(): void {
    try {
      pending?.el.removeAttribute(PROBE_ATTRIBUTE);
    } catch {
      // element gone — nothing to clean up
    }
  }

  function askForName(el: Element): void {
    const now = Date.now();
    if (pending && now - pending.at < QUERY_TIMEOUT_MS) return; // one question at a time
    const token = (queries += 1);
    try {
      el.setAttribute(PROBE_ATTRIBUTE, String(token));
    } catch {
      return; // read-only node — no name for this one
    }
    pending = { token, el, at: now };
    toMainWorld({ kind: COMPONENT_QUERY, token });
    // No answer (no MAIN-world script — a strict page CSP can block it) must
    // not leave our marker attribute behind on somebody's element.
    setTimeout(() => {
      if (pending?.token !== token) return;
      clearProbe();
      pending = null;
    }, QUERY_TIMEOUT_MS);
  }

  /**
   * Core wants a synchronous answer and the fiber lives in the other world, so
   * this is a cache with an async fill: the first hover asks, every later call
   * (the next mousemove, the note popover, the saved entry) is answered from
   * the cache. `""` means "asked, and the page has no component name for it".
   */
  function componentName(el: Element): string | undefined {
    const cached = names.get(el);
    if (cached !== undefined) return cached === "" ? undefined : cached;
    askForName(el);
    return undefined;
  }

  function onWindowMessage(event: MessageEvent): void {
    if (event.source !== window) return;
    const message = parseMainMessage(event.data);
    if (!message) return;
    if (message.kind === "console-error") {
      buffer.push(message.message, message.source);
      return;
    }
    if (pending && pending.token === message.token) {
      names.set(pending.el, message.name ?? "");
      clearProbe();
      pending = null;
    }
  }

  // --- service worker ------------------------------------------------------
  function onRuntimeMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const { type } = message as { type?: unknown };
    if (type === TOGGLE_OFF_MESSAGE) {
      teardown();
      return;
    }
    if (type === REVIEW_REQUESTED_MESSAGE) {
      const { request } = message as { request?: ReviewRequestMessage };
      if (!request) return;
      if (picker) picker.startReview(request);
      else queuedReview = request; // still waiting for config — apply on start
      return;
    }
    if (type === REVIEW_CANCELLED_MESSAGE) {
      queuedReview = null;
      picker?.endReview();
    }
  }

  async function readConfig(): Promise<ContentConfig | null> {
    try {
      const config: unknown = await chrome.runtime.sendMessage({ type: CONFIG_MESSAGE });
      if (typeof config !== "object" || config === null) return null;
      const { bridgeUrl: url, project, review } = config as ContentConfig;
      if (typeof url !== "string") return null;
      return { bridgeUrl: url, project, review };
    } catch {
      return null; // service worker gone or the extension was reloaded
    }
  }

  async function start(): Promise<void> {
    const config = await readConfig();
    if (!config || torn) return;
    bridgeUrl = config.bridgeUrl;

    host = document.createElement("div");
    host.setAttribute("data-fixui-host", "");
    // Zero-size anchor: everything inside is fixed-positioned by core's CSS.
    host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;";
    (document.body ?? document.documentElement).append(host);
    const shadow = host.attachShadow({ mode: "closed" });

    transport = createTransport({
      endpoint: `${config.bridgeUrl}/entries`,
      project: config.project,
      fetchImpl: bridgeFetch,
      // Storage stays the page's localStorage (one namespaced key), the same
      // durable queue the embed gets: a note taken while the bridge is down
      // must survive the reload that follows.
      ...(clipboard ? { clipboard } : {}),
    });

    picker = createPicker({
      transport,
      mount: shadow,
      project: config.project,
      capture: { consoleErrors: () => buffer.snapshot(), componentName },
    });
    unsubscribe = picker.onVerdict((verdict) => void postVerdict(verdict));

    // The toolbar click is the gesture that means "pick something".
    picker.enable();

    const review = queuedReview ?? config.review;
    queuedReview = null;
    if (review) picker.startReview(review);
  }

  function teardown(): void {
    if (torn) return;
    torn = true;
    unsubscribe?.();
    picker?.destroy();
    transport?.destroy();
    clearProbe();
    pending = null;
    window.removeEventListener("message", onWindowMessage);
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    // The MAIN-world script cannot be un-injected; tell it to stop instead.
    toMainWorld({ kind: CAPTURE_TOGGLE, on: false });
    host?.remove();
    host = null;
    delete (window as unknown as Record<string, unknown>)[INSTALLED];
  }

  // Listeners first: console errors start arriving the moment the MAIN-world
  // script is injected, which is before `start()` has its picker.
  window.addEventListener("message", onWindowMessage);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  // Re-arms a MAIN-world script left over from an earlier activation of this
  // same document (a fresh injection arms itself; one that fails to inject
  // would otherwise stay switched off after a toggle-off).
  toMainWorld({ kind: CAPTURE_TOGGLE, on: true });
  void start();
}

// One installation per document. A second injection (the service worker being
// defensive, a duplicate event) must not mount a second picker.
const globals = window as unknown as Record<string, unknown>;
if (globals[INSTALLED] !== true) {
  globals[INSTALLED] = true;
  install();
}

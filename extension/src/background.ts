import {
  CONFIG_MESSAGE,
  DEFAULT_BRIDGE_URL,
  FETCH_MESSAGE,
  OPTIONS_KEY,
  REVIEW_CANCELLED_MESSAGE,
  REVIEW_REQUESTED_MESSAGE,
  TOGGLE_OFF_MESSAGE,
  createSseParser,
  lookupLabel,
  lookupProject,
  normalizeBridgeUrl,
  originOf,
  parseFetchRequest,
  parseOriginMap,
  parseReviewRequested,
  streamIdentity,
  streamUrl,
  verdictReviewId,
  type FetchProxyResponse,
  type OriginMapping,
  type ReviewRequestMessage,
  type StoredOptions,
  type TabState,
  type TabStates,
} from "./protocol";

/**
 * The service worker owns everything a content script cannot do:
 *
 *   - **Injection.** Nothing runs on any page until the toolbar action is
 *     clicked (privacy: there is no `content_scripts` block in the manifest).
 *     A second click switches the tab back off.
 *   - **Bridge IO.** Content scripts inherit the page's mixed-content rules, so
 *     an https page cannot reach http://127.0.0.1. The worker holds the host
 *     permissions and does every fetch on the content script's behalf.
 *   - **The review channel.** One stream per ARMED TAB — that is what makes two
 *     windows on the same site individually addressable: each stream is its own
 *     *surface* at the bridge, described with the tab's real window/tab ids,
 *     title and url, and `request_review({surfaceId})` reaches exactly one of
 *     them (docs/agent-integration.md "Surfaces"). `EventSource` is not exposed
 *     in an extension service worker, so the SSE is a streamed `fetch` framed by
 *     `createSseParser`.
 *
 * MV3 workers are killed at will, which is the design constraint behind the
 * rest: tab state lives in `chrome.storage.session`, every entry point re-runs
 * `syncStreams()` (idempotent), and a `chrome.alarms` tick revives streams the
 * worker's death took with it. The bridge replays a pending review to a
 * reconnecting subscriber, so a revived stream lands back where it left off.
 */
const ALARM = "fixui:sync";
const TABS_KEY = "fixui.tabs.v1";
const CONTENT_FILE = "dist/content.js";
const MAIN_WORLD_FILE = "dist/main-world.js";

interface Stream {
  controller: AbortController;
  bridgeUrl: string;
  /** Re-opened when this changes: a stream on a stale token is a 401. */
  token: string;
  /** What the stream was opened for (protocol.ts `streamIdentity`): the project
   *  it files into and the site it is on. A same-origin navigation does NOT
   *  change it, so the tab keeps the surfaceId a review may be aimed at. */
  identity: string;
}

/**
 * Live streams and the review each one is currently showing, keyed by TAB ID.
 * In memory on purpose: a stream cannot outlive the worker, and the bridge
 * re-announces a pending untargeted review when the stream comes back.
 */
const streams = new Map<string, Stream>();
const pendingReviews = new Map<string, ReviewRequestMessage>();

// --- stored state ----------------------------------------------------------

async function readOptions(): Promise<{
  bridgeUrl: string;
  mappings: OriginMapping[];
  token: string;
}> {
  let stored: Partial<StoredOptions> | undefined;
  try {
    stored = (await chrome.storage.sync.get(OPTIONS_KEY))[OPTIONS_KEY] as
      | Partial<StoredOptions>
      | undefined;
  } catch {
    stored = undefined; // sync storage unavailable — defaults still work
  }
  const bridgeUrl =
    (typeof stored?.bridgeUrl === "string" ? normalizeBridgeUrl(stored.bridgeUrl) : null) ??
    DEFAULT_BRIDGE_URL;
  const { mappings } = parseOriginMap(typeof stored?.originMap === "string" ? stored.originMap : "");
  const token = typeof stored?.token === "string" ? stored.token.trim() : "";
  return { bridgeUrl, mappings, token };
}

/** `?token=` for a verdict URL. The token never leaves the worker: a content
 *  script lives in a tab, and this is the credential that decides whether
 *  somebody may answer the developer's review. (The stream's own URL is built
 *  by `streamUrl`, which carries the token the same way.) */
function withToken(url: string, token: string): string {
  if (!token) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("token", token);
  return parsed.href;
}

async function readTabs(): Promise<TabStates> {
  try {
    const stored = (await chrome.storage.session.get(TABS_KEY))[TABS_KEY] as TabStates | undefined;
    return typeof stored === "object" && stored !== null ? stored : {};
  } catch {
    return {};
  }
}

async function writeTabs(tabs: TabStates): Promise<void> {
  try {
    await chrome.storage.session.set({ [TABS_KEY]: tabs });
  } catch {
    // Nothing to do: the toggle still worked, it just won't survive a worker restart.
  }
}

// --- toolbar action --------------------------------------------------------

async function setBadge(tabId: number, on: boolean): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? "on" : "" });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: "#ef5b2a" });
  } catch {
    // Tab closed mid-flight.
  }
}

async function inject(tabId: number): Promise<void> {
  // Content script first: it must be listening before the MAIN-world script
  // starts posting console errors at it.
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILE] });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [MAIN_WORLD_FILE],
    world: "MAIN",
  });
}

async function turnOff(tabId: number, tabs: TabStates): Promise<void> {
  delete tabs[String(tabId)];
  await writeTabs(tabs);
  try {
    await chrome.tabs.sendMessage(tabId, { type: TOGGLE_OFF_MESSAGE });
  } catch {
    // Content script already gone (navigation, closed tab).
  }
  await setBadge(tabId, false);
  await syncStreams();
}

/**
 * What this tab is, as the bridge will list it (docs/agent-integration.md
 * "Surfaces"). `activeTab` — granted by the toolbar click — is what makes the
 * tab's url and title readable here; the window id needs no permission and is
 * what tells two windows on one site apart.
 */
function describeTab(tab: chrome.tabs.Tab, origin: string, mappings: OriginMapping[]): TabState {
  const project = lookupProject(mappings, origin);
  const label = lookupLabel(mappings, origin);
  const title = typeof tab.title === "string" ? tab.title.trim() : "";
  return {
    origin,
    ...(project === undefined ? {} : { project }),
    ...(label === undefined ? {} : { label }),
    ...(typeof tab.url === "string" && tab.url !== "" ? { url: tab.url } : {}),
    ...(title === "" ? {} : { title }),
    ...(typeof tab.windowId === "number" && tab.windowId >= 0 ? { windowId: tab.windowId } : {}),
  };
}

async function onAction(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id;
  const origin = originOf(tab.url);
  // chrome://, file://, the web store, a PDF viewer — nothing to inject into.
  if (tabId === undefined || tabId === chrome.tabs.TAB_ID_NONE || !origin) return;

  const tabs = await readTabs();
  if (tabs[String(tabId)]) {
    await turnOff(tabId, tabs);
    return;
  }

  const { mappings } = await readOptions();
  try {
    await inject(tabId);
  } catch {
    // activeTab was not granted for this page, or the page refuses injection.
    // Leave no state behind, so the next click tries again.
    await setBadge(tabId, false);
    return;
  }
  tabs[String(tabId)] = describeTab(tab, origin, mappings);
  await writeTabs(tabs);
  await setBadge(tabId, true);
  await syncStreams();
}

/**
 * A navigation kills the content script. While the tab is switched on, put it
 * back — a reload (or the review's own navigation) should not silently end
 * picking. `activeTab` survives same-origin navigation only; a cross-origin one
 * revokes it and the failed injection switches the tab off honestly.
 */
async function onNavigated(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) return;
  const tabs = await readTabs();
  const state = tabs[String(tabId)];
  if (!state) return;

  const origin = originOf(tab.url);
  if (!origin) {
    await turnOff(tabId, tabs);
    return;
  }
  try {
    await inject(tabId);
  } catch {
    await turnOff(tabId, tabs);
    return;
  }
  // The tab now shows a different page: remember it, so a stream opened from
  // here on describes where the tab actually is. A same-origin move does not
  // re-open the live stream (see `streamIdentity`) — the surface a review may
  // be aimed at, quite possibly by the review that asked for this navigation,
  // has to survive the move.
  const { mappings } = await readOptions();
  tabs[String(tabId)] = describeTab(tab, origin, mappings);
  await writeTabs(tabs);
  await setBadge(tabId, true);
  await syncStreams();
}

// --- review channel --------------------------------------------------------

/** One stream, one tab: whatever arrives on it is for that tab and no other.
 *  The delivery ambiguity the old project-wide fan-out had to guard against
 *  cannot arise — there is nothing to choose between. */
async function tell(tabId: string, message: unknown): Promise<void> {
  try {
    await chrome.tabs.sendMessage(Number(tabId), message);
  } catch {
    // No content script in that tab right now — it will ask for config when it
    // is injected, and a pending review travels in the answer.
  }
}

/**
 * The adapter navigates when the agent asked for a review of a specific URL
 * (docs/agent-integration.md). Same-origin only: a local bridge has no business
 * steering somebody's tab off-site, and a cross-origin navigation would revoke
 * `activeTab` anyway.
 */
async function navigateFor(tabId: string, url: string): Promise<void> {
  const target = originOf(url);
  if (!target) return;
  const state = (await readTabs())[tabId];
  if (!state || state.origin !== target) return;
  try {
    await chrome.tabs.update(Number(tabId), { url });
  } catch {
    // Tab gone.
  }
}

async function dispatch(tabId: string, event: { event: string; data: string }): Promise<void> {
  if (event.event === "review-requested") {
    const request = parseReviewRequested(event.data);
    if (!request) return;
    pendingReviews.set(tabId, request);
    await tell(tabId, { type: REVIEW_REQUESTED_MESSAGE, request });
    if (request.url) await navigateFor(tabId, request.url);
    return;
  }
  if (event.event === "review-cancelled") {
    pendingReviews.delete(tabId);
    await tell(tabId, { type: REVIEW_CANCELLED_MESSAGE });
  }
  // `surface` (the id the bridge assigned this tab) needs no action here: the
  // agent reads it from the bridge's own `list_surfaces`, and the worker has
  // nothing to say back on the stream.
}

async function pump(
  tabId: string,
  url: string,
  controller: AbortController,
): Promise<void> {
  const response = await fetch(url, {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
  });
  if (!response.ok || !response.body) throw new Error(`bridge answered ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    for (const event of parser.push(decoder.decode(value, { stream: true }))) {
      await dispatch(tabId, event);
    }
  }
}

function openStream(tabId: string, state: TabState, bridgeUrl: string, token: string): void {
  const controller = new AbortController();
  // Registered before the first await, so two overlapping syncStreams() cannot
  // open the same stream twice.
  streams.set(tabId, { controller, bridgeUrl, token, identity: streamIdentity(state) });
  void pump(tabId, streamUrl(bridgeUrl, tabId, state, token), controller)
    .catch(() => {
      // Bridge down, restarted, or the worker is being torn down. The alarm
      // (and the next event of any kind) re-opens it.
    })
    .finally(() => {
      if (streams.get(tabId)?.controller === controller) streams.delete(tabId);
    });
}

/**
 * An open stream usually keeps the worker alive, but "usually" is not a
 * lifecycle guarantee: this tick is what makes recovery certain. It exists only
 * while some tab is switched on — an extension has no business waking a
 * sleeping machine once a minute for nothing. `create` restarts the period, so
 * it must not run on every worker wake-up or the tick never arrives.
 */
async function keepAlarm(wanted: boolean): Promise<void> {
  try {
    if (!wanted) {
      await chrome.alarms.clear(ALARM);
      return;
    }
    if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  } catch {
    // Alarms unavailable — every other entry point still calls syncStreams().
  }
}

/**
 * Bring the set of open streams in line with the tabs that are switched on.
 * Idempotent and safe to call from anywhere — it is the recovery path for a
 * worker that was asleep when the bridge restarted.
 */
async function syncStreams(): Promise<void> {
  const tabs = await readTabs();
  const { bridgeUrl, token } = await readOptions();

  for (const [tabId, stream] of [...streams]) {
    const state = tabs[tabId];
    // Kept only while the tab is still armed at the same bridge, on the same
    // token, for the same project and site. A same-origin navigation is none of
    // those: the stream — and the surfaceId a review may name — stays put.
    const keep =
      state !== undefined &&
      stream.bridgeUrl === bridgeUrl &&
      stream.token === token &&
      stream.identity === streamIdentity(state);
    if (keep) continue;
    stream.controller.abort();
    streams.delete(tabId);
    pendingReviews.delete(tabId);
  }
  for (const [tabId, state] of Object.entries(tabs)) {
    if (!streams.has(tabId)) openStream(tabId, state, bridgeUrl, token);
  }
  await keepAlarm(Object.keys(tabs).length > 0);
}

// --- messages from content scripts ------------------------------------------

async function handleFetch(
  message: unknown,
  respond: (response: FetchProxyResponse) => void,
): Promise<void> {
  const { bridgeUrl, token } = await readOptions();
  const request = parseFetchRequest(message, bridgeUrl);
  if (!request) {
    respond({ ok: false, error: `fixui: refused a request that is not for ${bridgeUrl}` });
    return;
  }
  // The verdict route is token-gated, and the content script does not hold the
  // token — the worker adds it here, on a URL it has already checked belongs to
  // the configured bridge.
  const reviewId = verdictReviewId(request.url);
  const url = reviewId ? withToken(request.url, token) : request.url;
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    const body = await response.text();
    respond({ ok: true, status: response.status, statusText: response.statusText, body });

    // A delivered verdict ends the review: forget it so a page reloaded later
    // is not shown a banner for a review that is already resolved.
    if (response.ok && reviewId) {
      for (const [key, review] of pendingReviews) {
        if (review.reviewId === reviewId) pendingReviews.delete(key);
      }
    }
  } catch (error) {
    respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleConfig(
  sender: chrome.runtime.MessageSender,
  respond: (config: unknown) => void,
): Promise<void> {
  const { bridgeUrl, mappings } = await readOptions();
  const tabId = sender.tab?.id;
  const origin = originOf(sender.url ?? sender.tab?.url);

  // The stored state is what the streams are keyed on; fall back to a fresh
  // lookup for a content script that outlived its record.
  const tabs = await readTabs();
  const state = tabId === undefined ? undefined : tabs[String(tabId)];
  const project = state ? state.project : lookupProject(mappings, origin);
  // A review pending for THIS tab, and only this tab: a fresh content script
  // (the navigation the review itself asked for) re-arms with the banner the
  // stream already delivered. No ambiguity to resolve any more — a stream
  // belongs to one tab, so a pending review names one tab.
  const review = tabId === undefined ? undefined : pendingReviews.get(String(tabId));

  respond({ bridgeUrl, project, review });
}

// --- wiring -----------------------------------------------------------------

chrome.action.onClicked.addListener((tab) => void onAction(tab));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") void onNavigated({ ...tab, id: tabId });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const tabs = await readTabs();
    if (!tabs[String(tabId)]) return;
    delete tabs[String(tabId)];
    await writeTabs(tabs);
    await syncStreams();
  })();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type } = (message ?? {}) as { type?: unknown };
  if (type === FETCH_MESSAGE) {
    void handleFetch(message, sendResponse);
    return true; // answering asynchronously
  }
  if (type === CONFIG_MESSAGE) {
    void handleConfig(sender, sendResponse);
    return true;
  }
  return undefined;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void syncStreams();
});

chrome.runtime.onStartup.addListener(() => void syncStreams());
chrome.runtime.onInstalled.addListener(() => void syncStreams());

// Every worker wake-up is also a chance to notice a stream that died with the
// last one.
void syncStreams();

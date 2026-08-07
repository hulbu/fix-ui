import {
  connectReviewChannel,
  createConsoleBuffer,
  createPicker,
  createTransport,
  type FeedbackEntry,
  type Picker,
} from "../core/index.js";

/**
 * The npm embed (docs/design.md "the npm embed"): one call
 * wires core's picker to a transport, to the page's console errors, and to the
 * bridge's review channel — the browser realities core deliberately refuses to
 * assume. Dev-builds only by convention: `initFixUi` always runs when called;
 * only `<FixUi />` (./react) self-guards on NODE_ENV.
 */
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:3499";

export interface FixUiOptions {
  /** An app route that speaks the entries protocol, e.g. "/api/ui-feedback".
   *  Bridge-less — no review channel unless `bridgeUrl` is named too. */
  endpoint?: string;
  /** Where the local daemon lives; defaults to `http://127.0.0.1:3499` when
   *  no `endpoint` is given. */
  bridgeUrl?: string;
  /** Absolute project directory the bridge routes entries on. */
  project?: string;
  /**
   * The bridge's review-channel token. The bridge prints it at startup and
   * publishes it, with its port, in `.fix-ui.json` at the project root; a page
   * cannot read that file, so a dev build has to be handed it explicitly (an env var
   * baked in by the bundler is the usual way). Without it `GET /events` and the
   * verdict POST answer 401 and only the note-taking half of the loop works —
   * which is exactly the bridge-less experience, and a fine place to be.
   */
  token?: string;
  /**
   * A human name for THIS page on the review channel — "staging", "port 4001".
   * The agent sees it in `list_surfaces` and can aim a review at exactly this
   * page (docs/agent-integration.md "Surfaces"). Everything else about the
   * surface (origin, url, title) the embed reads off the page itself.
   */
  label?: string;
  /** The brand colour: the highlight box, the buttons, and the chip. */
  accent?: string;
  chip?: boolean;
  onSaved?: (entry: FeedbackEntry) => void;
}

/**
 * @internal Test seam, not supported API. A dev tool has no business making
 * its IO configurable (YAGNI) — but the wiring below is only honestly
 * testable with the browser's IO replaced.
 */
export interface FixUiInternals {
  fetchImpl?: typeof fetch;
  eventSourceImpl?: typeof EventSource;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  clipboard?: (text: string) => Promise<void>;
}

const trimSlashes = (url: string): string => url.replace(/\/+$/, "");

/**
 * Core takes no clipboard by default — the last-resort copy is the adapter's
 * call. Where the browser has none (insecure origin, older engine) the option
 * stays off entirely, so the transport keeps retrying instead of "delivering"
 * entries to a clipboard that isn't there.
 */
function defaultClipboard(): ((text: string) => Promise<void>) | undefined {
  if (typeof navigator === "undefined" || !navigator.clipboard) return undefined;
  return (text) => navigator.clipboard.writeText(text);
}

export function initFixUi(
  options: FixUiOptions = {},
  internals: FixUiInternals = {},
): Picker & { close(): void; readonly surfaceId: string | undefined } {
  let endpoint: string;
  let bridgeUrl: string | undefined;
  if (options.endpoint === undefined) {
    bridgeUrl = trimSlashes(options.bridgeUrl ?? DEFAULT_BRIDGE_URL);
    endpoint = `${bridgeUrl}/entries`;
  } else {
    // A custom endpoint is an app route, and an app route can't push SSE — so
    // the review channel connects only when a bridge is named as well.
    endpoint = options.endpoint;
    bridgeUrl = options.bridgeUrl === undefined ? undefined : trimSlashes(options.bridgeUrl);
  }

  // Installed at init, so an entry can carry what the page was screaming about
  // before the user reached for the picker.
  const buffer = createConsoleBuffer();
  buffer.install();

  const clipboard = internals.clipboard ?? defaultClipboard();
  const transport = createTransport({
    endpoint,
    project: options.project,
    fetchImpl: internals.fetchImpl,
    storage: internals.storage,
    ...(clipboard ? { clipboard } : {}),
  });

  const picker = createPicker({
    transport,
    project: options.project,
    accent: options.accent,
    chip: options.chip,
    onSaved: options.onSaved,
    // componentName stays core's default (React fibers) — nothing here knows better.
    capture: { consoleErrors: () => buffer.snapshot() },
  });

  // No EventSource (jsdom, an old browser) → no channel, rather than a throw:
  // notes still flow, only the agent-initiated review direction is missing.
  const EventSourceImpl = internals.eventSourceImpl ?? globalThis.EventSource;
  const review =
    bridgeUrl !== undefined && typeof EventSourceImpl === "function"
      ? connectReviewChannel({
          bridgeUrl,
          project: options.project,
          token: options.token,
          // What this page is, so an agent can aim a review at it rather than
          // at every page of the project. Read off the page — the developer
          // only ever names the `label`.
          describe: {
            adapter: "embed",
            ...(typeof location === "undefined"
              ? {}
              : { origin: location.origin, url: location.href }),
            ...(typeof document === "undefined" ? {} : { title: document.title }),
            ...(options.label === undefined ? {} : { label: options.label }),
          },
          picker,
          fetchImpl: internals.fetchImpl,
          eventSourceImpl: EventSourceImpl,
        })
      : undefined;

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    picker.destroy();
    review?.close();
    buffer.uninstall();
    transport.destroy();
  }

  return {
    enable: picker.enable,
    disable: picker.disable,
    toggle: picker.toggle,
    // The picker's own teardown; `close()` is the whole embed — console buffer,
    // review channel and transport included.
    destroy: picker.destroy,
    startReview: picker.startReview,
    endReview: picker.endReview,
    onVerdict: picker.onVerdict,
    refresh: picker.refresh,
    // A getter, not a copy: `active` has to track the live picker.
    get active() {
      return picker.active;
    },
    /** This page's id on the review channel, once the bridge has assigned one
     *  — what `request_review({surfaceId})` aims at. Undefined with no review
     *  channel, or before the stream's first event arrives. */
    get surfaceId() {
      return review?.surfaceId;
    },
    close,
  };
}

export type { FeedbackEntry, Picker } from "../core/index.js";

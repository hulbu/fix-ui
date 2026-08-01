import { getReactComponentName } from "@hulbu/fixui-core";
import {
  CAPTURE_TOGGLE,
  COMPONENT_QUERY,
  CONTENT_SOURCE,
  MAIN_SOURCE,
  MAX_MAIN_MESSAGE,
  PROBE_ATTRIBUTE,
} from "./protocol";

/**
 * The MAIN-world half of the extension (docs/design.md "fix-ui extension"):
 * the only code that runs in the page's own JavaScript reality, because two
 * things are invisible from a content script's isolated world —
 *
 *   1. the page's `console.error` (the content script has its own console), and
 *   2. framework internals: React hangs its fiber off the DOM node as an
 *      expando (`__reactFiber$…`), and expandos are NOT shared across worlds —
 *      only the DOM itself is. This is why React DevTools injects into the page
 *      too, and why component detection cannot live in the content script.
 *
 * Both travel back by `postMessage`, which the content script treats as
 * hostile input (see `parseMainMessage`). Nothing here is trusted; nothing here
 * trusts the page either — every page-facing call is guarded, since a page that
 * broke this script would take the picker's capture down with it.
 *
 * Installed on injection, so errors are captured from activation onward — a
 * documented v1 limitation: whatever the page logged before you clicked the
 * toolbar button is gone.
 */
const STATE = "__fixuiMainWorld";

interface MainState {
  /** Toggled off when the content script tears down, so a page you switched
   *  off is not left instrumented until its next reload. */
  capturing: boolean;
}

/** Same-window messaging: `"*"` is the target, and the content script filters
 *  on `event.source === window`. The payloads are the page's own text. */
function post(payload: Record<string, unknown>): void {
  try {
    window.postMessage({ source: MAIN_SOURCE, ...payload }, "*");
  } catch {
    // A page that broke postMessage gets no capture. Not ours to fix.
  }
}

function format(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    if (value instanceof Error) return String(value);
    return JSON.stringify(value) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}

function install(state: MainState): void {
  function report(message: string, sourceRef?: string): void {
    if (!state.capturing) return;
    const text = message.slice(0, MAX_MAIN_MESSAGE);
    if (!text.trim()) return;
    post(
      sourceRef
        ? { kind: "console-error", message: text, sourceRef }
        : { kind: "console-error", message: text },
    );
  }

  // Wrapped once, always delegating to the original: the page's own devtools
  // output must look exactly as it did before we arrived.
  try {
    const original = console.error;
    if (typeof original === "function") {
      console.error = function wrapped(this: unknown, ...args: unknown[]): void {
        report(args.map(format).join(" "));
        original.apply(this ?? console, args);
      };
    }
  } catch {
    // Frozen console — the error events below still work.
  }

  window.addEventListener("error", (event) => {
    const { message, error, filename } = event;
    report(message || format(error), typeof filename === "string" && filename ? filename : undefined);
  });

  window.addEventListener("unhandledrejection", (event) => {
    report(format(event.reason));
  });

  // Component-name queries. An element reference cannot cross the world
  // boundary, but the DOM is shared: the content script marks the element it is
  // asking about with PROBE_ATTRIBUTE = token, and we look it up here.
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as Record<string, unknown> | null;
    if (typeof data !== "object" || data === null || data.source !== CONTENT_SOURCE) return;

    if (data.kind === CAPTURE_TOGGLE) {
      state.capturing = data.on === true;
      return;
    }
    if (data.kind !== COMPONENT_QUERY) return;

    const { token } = data;
    if (typeof token !== "number" || !Number.isInteger(token)) return;
    let name: string | undefined;
    try {
      const el = document.querySelector(`[${PROBE_ATTRIBUTE}="${token}"]`);
      if (el) name = getReactComponentName(el);
    } catch {
      // Answer anyway (nameless), so the content script's query resolves
      // instead of blocking the next one until it times out.
    }
    post(name ? { kind: "component-name", token, name } : { kind: "component-name", token });
  });
}

// Re-injection (a second activation, a reload) must not double-wrap the
// console: the state object is the installation, and re-arming it is all a
// fresh content script needs.
const globals = window as unknown as Record<string, unknown>;
const existing = globals[STATE] as MainState | undefined;
if (existing && typeof existing === "object") existing.capturing = true;
else {
  const state: MainState = { capturing: true };
  globals[STATE] = state;
  install(state);
}

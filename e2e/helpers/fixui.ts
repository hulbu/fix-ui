import { expect, test as base, type Page } from "@playwright/test";
import { startBridge, type Bridge, type JsonRecord } from "./bridge";

/**
 * The shared vocabulary of the suite: a per-test bridge, the picker's own
 * selectors, and the two flows every spec repeats (arm the picker, leave a
 * note). Anything a spec asserts stays in the spec.
 */

/** Core stamps its UI with `data-uifb-*` attributes; these are the handles. */
export const CHIP = "[data-uifb-chip]";
export const PANEL = "[data-uifb-panel]";
export const PICK = "[data-uifb-pick]";
export const POP = "[data-uifb-pop]";
export const NOTE = "[data-uifb-pop] textarea";
export const SAVE = "[data-uifb-save]";
export const BOX = "[data-uifb-box]";
export const TOAST = "[data-uifb-toast]";
/**
 * The agent's prompt, inside the notes panel — there is no separate banner any
 * more: a session or a review IS the panel, with the prompt at the top and the
 * buttons under the notes they act on. Its presence is the whole test for "the
 * page is showing an agent's request".
 */
export const AGENT = "[data-uifb-agent]";
/** The panel's live mark, up for as long as a request is — minimized or not. */
export const LIVE = "[data-uifb-live]";
export const APPROVE = "[data-uifb-approve]";
export const CHANGES = "[data-uifb-changes]";
/** A session's one button — the whole of what it asks for. */
export const SUBMIT = "[data-uifb-submit]";
/** Fold the panel to its header bar. */
export const MINIMIZE = "[data-uifb-min]";
/** The note count on the chip. Absent entirely when the inbox is empty. */
export const BADGE = "[data-uifb-badge]";
/** The per-note delete button — one per row in the panel. */
export const DEL = "[data-uifb-del]";
/** The chip's glyph, in its own element so the armed pulse can target it. */
export const GLYPH = "[data-uifb-glyph]";
/** The panel's header bar, and the dotted grip that says it can be dragged. */
export const HEAD = "[data-uifb-head]";
export const GRIP = "[data-uifb-grip]";
/** Any mark the picker draws for itself — an inline SVG path, never a glyph. */
export const MARK = "[data-uifb-mark]";

export const test = base.extend<{ bridge: Bridge }>({
  bridge: async ({}, use) => {
    const bridge = await startBridge();
    await use(bridge);
    // Kills the daemon and removes the temp project — no leaked processes, no
    // leaked directories, whether the test passed or failed.
    await bridge.stop();
  },
});

export { expect } from "@playwright/test";
export type { Bridge, JsonRecord } from "./bridge";

/** A fixture page wired to this test's bridge, project and review token.
 *  `extra` is anything else the page reads off its own URL — `label`, which the
 *  fixture hands to `initFixUi` as this surface's name. */
export function fixtureUrl(
  baseURL: string,
  file: string,
  bridge: Bridge,
  extra: Record<string, string> = {},
): string {
  const query = new URLSearchParams({
    bridge: bridge.url,
    project: bridge.project,
    // A real app bakes this in at build time; a fixture page has a query string.
    token: bridge.token,
    ...extra,
  });
  return `${baseURL}/${file}?${query.toString()}`;
}

/**
 * Open a fixture and wait until its review channel is actually connected.
 *
 * `request_review` answers `no-reviewer` immediately when nobody is
 * subscribed, so every review spec depends on this: the SSE response headers
 * arrive only after the bridge registered the subscriber (both happen in one
 * synchronous turn of the daemon's request handler).
 */
export async function openFixture(
  page: Page,
  baseURL: string,
  file: string,
  bridge: Bridge,
  extra: Record<string, string> = {},
) {
  const connected = page.waitForResponse((res) => res.url().includes("/events"));
  const response = await page.goto(fixtureUrl(baseURL, file, bridge, extra));
  await connected;
  return response;
}

/** One connected page, as the agent's `list_surfaces` sees it. */
export interface Surface extends JsonRecord {
  surfaceId: string;
  project: string;
  origin?: string;
  url?: string;
  title?: string;
  label?: string;
  adapter?: "embed" | "extension";
}

/**
 * What the agent can see: `GET /surfaces` is the HTTP route behind the
 * `list_surfaces` MCP tool (proxy mode literally calls it). Token-gated, like
 * the stream it describes.
 */
export async function listSurfaces(bridge: Bridge, project?: string): Promise<Surface[]> {
  const query = new URLSearchParams({ token: bridge.token });
  if (project) query.set("project", project);
  const res = await fetch(`${bridge.url}/surfaces?${query.toString()}`);
  if (!res.ok) throw new Error(`GET /surfaces answered ${res.status}`);
  return ((await res.json()) as { surfaces: Surface[] }).surfaces;
}

/** The user's route into picking: chip → notes panel → "Pick an element". */
export async function armPicker(page: Page): Promise<void> {
  await page.locator(CHIP).click();
  await page.locator(PICK).click();
  await expect(page.locator(PANEL)).toHaveCount(0);
}

/**
 * Pick `selector` and save `note` — the whole point of the product.
 *
 * Waits for the "Saved" toast, which is the only signal that the POST came
 * back `ok` (the popover closes before the request is even sent, and a review's
 * entry list is appended to after it resolves). "Bridge unreachable — queued"
 * is the toast a broken wiring produces, and it fails this wait.
 */
export async function pickAndNote(page: Page, selector: string, note: string): Promise<void> {
  await page.locator(selector).click();
  await expect(page.locator(POP)).toBeVisible();
  await page.locator(NOTE).fill(note);
  await page.locator(SAVE).click();
  await expect(page.locator(POP)).toHaveCount(0);
  // `.last()`: toasts stack for a couple of seconds, so leaving several notes
  // in a row (which is the whole gesture a session is built around) leaves more
  // than one "Saved" on screen. The newest is the reply to what just happened.
  await expect(page.locator(TOAST).filter({ hasText: "Saved" }).last()).toBeVisible();
}

/**
 * The agent resolving an entry. `resolve_feedback` is this exact call in proxy
 * mode (mcp.ts `httpTools`), which is the only mode an agent harness ever gets
 * — so this is the agent's own hand, not a shortcut around it.
 */
export async function resolveFeedback(bridge: Bridge, id: string): Promise<void> {
  const query = `?project=${encodeURIComponent(bridge.project)}`;
  const res = await fetch(`${bridge.url}/entries/${encodeURIComponent(id)}${query}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`DELETE /entries/${id} answered ${res.status}`);
}

export interface ReviewOutcome extends JsonRecord {
  verdict: "approved" | "changes" | "submitted" | "timeout" | "no-reviewer";
  entries: JsonRecord[];
  durationMs: number;
}

export interface HeldReview {
  /** Settles when the human answers on the page — the agent's held tool call. */
  outcome: Promise<ReviewOutcome>;
  /** Has the agent's call come back yet? */
  settled(): boolean;
}

/**
 * The test acting as the agent: `POST /reviews` is the same held call
 * `request_review` makes (the MCP tool is a thin wrapper over the broker, and
 * proxy mode literally posts this route). Deliberately not awaited — the whole
 * point is that it stays open until the page answers.
 */
export function requestReview(
  bridge: Bridge,
  body: {
    prompt: string;
    url?: string;
    surfaceId?: string;
    timeoutSeconds?: number;
    /** `session` is what `start_fix_ui_session` posts — the Submit button. */
    mode?: "review" | "session";
  },
): HeldReview {
  let settled = false;
  const outcome = fetch(`${bridge.url}/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, project: bridge.project }),
  })
    .then(async (res) => {
      const payload = (await res.json()) as ReviewOutcome;
      if (!res.ok) throw new Error(`POST /reviews answered ${res.status}: ${JSON.stringify(payload)}`);
      return payload;
    })
    .finally(() => {
      settled = true;
    });

  // A test that fails before it answers the review leaves this call in flight
  // until the bridge is killed in teardown. Whoever awaits `outcome` still sees
  // that rejection — this only keeps it from becoming an unhandled one that
  // takes the whole run down with a second, misleading failure.
  outcome.catch(() => undefined);

  return { outcome, settled: () => settled };
}

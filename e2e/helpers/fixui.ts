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
export const BANNER = "[data-uifb-banner]";
export const APPROVE = "[data-uifb-approve]";
export const CHANGES = "[data-uifb-changes]";

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

/** A fixture page wired to this test's bridge and project. */
export function fixtureUrl(baseURL: string, file: string, bridge: Bridge): string {
  const query = new URLSearchParams({ bridge: bridge.url, project: bridge.project });
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
export async function openFixture(page: Page, baseURL: string, file: string, bridge: Bridge) {
  const connected = page.waitForResponse((res) => res.url().includes("/events"));
  const response = await page.goto(fixtureUrl(baseURL, file, bridge));
  await connected;
  return response;
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
  await expect(page.locator(TOAST).filter({ hasText: "Saved" })).toBeVisible();
}

export interface ReviewOutcome extends JsonRecord {
  verdict: "approved" | "changes" | "timeout" | "no-reviewer";
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
  body: { prompt: string; url?: string; timeoutSeconds?: number },
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

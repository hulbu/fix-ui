import {
  APPROVE,
  BANNER,
  CHANGES,
  expect,
  fixtureUrl,
  openFixture,
  pickAndNote,
  requestReview,
  test,
} from "../helpers/fixui";

/**
 * Direction 2 end to end (docs/agent-integration.md): the test plays the agent
 * — `POST /reviews` is the held call `request_review` makes — and the browser
 * plays the human. Nothing is stubbed: a real daemon holds a real HTTP request
 * open while a real page arms itself over SSE.
 */
test("request changes with a note: the held call answers with the entry", async ({
  page,
  baseURL,
  bridge,
}) => {
  await openFixture(page, baseURL!, "basic.html", bridge);

  const review = requestReview(bridge, { prompt: "Check the hero section" });

  // The plugin activates itself — banner up, picker armed, no chip hunting.
  const banner = page.locator(BANNER);
  await expect(banner).toContainText("Check the hero section");
  expect(review.settled()).toBe(false);
  expect(await page.evaluate(() => window.fixui.active)).toBe(true);

  await pickAndNote(page, "#save-btn", "Hero copy is stale — say 'Ship it'");
  await page.locator(CHANGES).click();

  const outcome = await review.outcome;
  expect(outcome.verdict).toBe("changes");
  expect(outcome.entries).toHaveLength(1);
  expect(outcome.entries[0]).toMatchObject({
    note: "Hero copy is stale — say 'Ship it'",
    selector: "#save-btn",
  });
  expect(outcome.durationMs).toBeGreaterThan(0);

  // The audit trail (docs/capture-format.md "Review session records").
  const [record] = await bridge.reviews();
  expect(record).toMatchObject({ prompt: "Check the hero section", verdict: "changes" });
  expect(record!.entryIds).toEqual([(outcome.entries[0] as { id: string }).id]);
  expect(typeof record!.requestedAt).toBe("string");
  expect(typeof record!.resolvedAt).toBe("string");

  await expect(banner).toHaveCount(0);
});

test("approve with no notes: the agent gets an empty verdict", async ({
  page,
  baseURL,
  bridge,
}) => {
  await openFixture(page, baseURL!, "basic.html", bridge);

  const review = requestReview(bridge, { prompt: "Anything wrong with the toolbar?" });
  await expect(page.locator(BANNER)).toContainText("Anything wrong with the toolbar?");

  await page.locator(APPROVE).click();

  expect(await review.outcome).toMatchObject({ verdict: "approved", entries: [] });
  expect(await bridge.entries()).toEqual([]);
  expect(await bridge.reviews()).toMatchObject([{ verdict: "approved", entryIds: [] }]);
});

/**
 * ★ `request_review({url})` moves the reviewer, and the banner has to survive
 * the move. It cannot survive it as an object — the page is torn down — so this
 * is the end-to-end proof of the bridge's replay-on-connect: the fresh page's
 * SSE stream is answered with the review that is still pending.
 */
test("a review with a url navigates the page and the banner comes back", async ({
  page,
  baseURL,
  bridge,
}) => {
  await openFixture(page, baseURL!, "basic.html", bridge);

  const target = fixtureUrl(baseURL!, "pricing.html", bridge);
  const review = requestReview(bridge, { prompt: "Is the upgrade button obvious?", url: target });

  await page.waitForURL((url) => url.pathname.endsWith("/pricing.html"));
  await expect(page.locator("#pricing-title")).toBeVisible();
  expect(review.settled()).toBe(false);

  // Nothing re-sent this: the new page connected and the bridge replayed the
  // review that was still pending for this project.
  await expect(page.locator(BANNER)).toContainText("Is the upgrade button obvious?");
  expect(await page.evaluate(() => window.fixui.active)).toBe(true);

  await page.locator(APPROVE).click();
  expect(await review.outcome).toMatchObject({ verdict: "approved" });
});

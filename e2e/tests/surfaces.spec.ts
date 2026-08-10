import {
  AGENT,
  APPROVE,
  expect,
  listSurfaces,
  openFixture,
  requestReview,
  test,
} from "../helpers/fixui";

/**
 * Two pages, one bridge, one project — the case routing by project alone cannot
 * express (docs/agent-integration.md "Surfaces"). The test plays the agent:
 * `GET /surfaces` is what `list_surfaces` answers with, and `POST /reviews
 * {surfaceId}` is `request_review` aimed at one page. The browser plays the
 * human, twice over.
 */
test("a review aimed at one surface reaches that page and no other", async ({
  page,
  baseURL,
  bridge,
}) => {
  await openFixture(page, baseURL!, "basic.html", bridge, { label: "window alpha" });
  const second = await page.context().newPage();
  await openFixture(second, baseURL!, "basic.html", bridge, { label: "window beta" });

  // Same project, same origin, same page — and still individually addressable.
  const surfaces = await listSurfaces(bridge, bridge.project);
  expect(surfaces.map((surface) => surface.label)).toEqual(["window beta", "window alpha"]);
  for (const surface of surfaces) {
    expect(surface).toMatchObject({
      project: bridge.project,
      origin: new URL(baseURL!).origin,
      adapter: "embed",
      title: "fix-ui e2e — basic", // the page's own <title>, read by the embed
    });
    expect(surface.url).toContain("/basic.html");
  }
  const beta = surfaces.find((surface) => surface.label === "window beta")!;

  const aimed = requestReview(bridge, {
    prompt: "Only the second window, please",
    surfaceId: beta.surfaceId,
  });

  await expect(second.locator(AGENT)).toContainText("Only the second window, please");
  // The first page never hears about it — nothing opens, and its picker stays
  // down.
  await expect(page.locator(AGENT)).toHaveCount(0);
  expect(await page.evaluate(() => window.fixui.active)).toBe(false);
  expect(aimed.settled()).toBe(false);

  await second.locator(APPROVE).click();
  expect(await aimed.outcome).toMatchObject({ verdict: "approved", entries: [] });
  await expect(page.locator(AGENT)).toHaveCount(0);

  // An id nobody holds is answered honestly rather than shown to everybody.
  const nowhere = await requestReview(bridge, {
    prompt: "aimed at a page that is not there",
    surfaceId: "not-a-surface",
  }).outcome;
  expect(nowhere).toMatchObject({ verdict: "no-reviewer", entries: [], durationMs: 0 });
  await expect(page.locator(AGENT)).toHaveCount(0);
  await expect(second.locator(AGENT)).toHaveCount(0);

  // …and a review that names no surface still reaches every page of the project.
  const everyone = requestReview(bridge, { prompt: "Everyone, look at the toolbar" });
  await expect(page.locator(AGENT)).toContainText("Everyone, look at the toolbar");
  await expect(second.locator(AGENT)).toContainText("Everyone, look at the toolbar");

  await page.locator(APPROVE).click();
  expect(await everyone.outcome).toMatchObject({ verdict: "approved" });

  // A page that goes away takes its surface with it.
  await second.close();
  await expect
    .poll(async () => (await listSurfaces(bridge, bridge.project)).map((s) => s.label))
    .toEqual(["window alpha"]);
});

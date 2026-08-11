import {
  AGENT,
  APPROVE,
  armPicker,
  BOX,
  expect,
  NOTE,
  openFixture,
  POP,
  requestReview,
  PANEL,
  SAVE,
  test,
  TOAST,
} from "../helpers/fixui";

/**
 * The prototype's hardest-won lesson, in the only environment that can prove it
 * (docs/design.md "Picking mechanics"): a REAL `showModal()` puts the dialog in
 * the browser's top layer and makes everything outside it inert. jsdom has
 * neither a top layer nor inertness, so Task 3's unit tests could only assert
 * that the picker *moves* its UI — whether the moved UI is actually clickable
 * is a question only Chromium can answer.
 */
test("picking inside an open modal: click suppressed, UI interactive, entry saved", async ({
  page,
  baseURL,
  bridge,
}) => {
  await openFixture(page, baseURL!, "modal.html", bridge);

  await page.locator("#open-modal").click();
  const dialog = page.locator("#modal-dialog");
  await expect(dialog).toBeVisible();
  // Not `dialog[open]` — `:modal` is true only for a real top-layer modal.
  expect(await dialog.evaluate((el) => el.matches(":modal"))).toBe(true);

  // Arming from the chip at all is the re-homing proof: the chip is only
  // clickable if it moved into the dialog's subtree (everything else is inert).
  await armPicker(page);

  // The counter runs off the page's own capture-phase listener on `document` —
  // the picker still wins, because it listens on `window`.
  await page.locator(".counter-btn").click();
  await expect(page.locator("#count")).toHaveText("0");

  // The highlight box followed the pointer into the dialog…
  const box = page.locator(BOX);
  await expect(box).toBeVisible();
  expect(await box.evaluate((el) => el.closest("dialog")?.id ?? null)).toBe("modal-dialog");

  // ★ …and the picker's own UI is INTERACTIVE inside the open modal: typing and
  // clicking Save here fail outright if the top-layer/inert handling is wrong.
  await expect(page.locator(POP)).toBeVisible();
  expect(await page.locator(POP).evaluate((el) => el.closest("dialog")?.id ?? null)).toBe(
    "modal-dialog",
  );
  await page.locator(NOTE).fill("The counter button should say 'Add one'");
  await page.locator(SAVE).click();
  await expect(page.locator(TOAST).filter({ hasText: "Saved" })).toBeVisible();

  await expect.poll(async () => (await bridge.entries()).length).toBe(1);
  const [entry] = await bridge.entries();
  expect(entry).toMatchObject({ note: "The counter button should say 'Add one'" });

  // The selector resolves to the button inside the dialog, not to some
  // same-looking element outside it.
  const resolved = await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    return el
      ? { dialog: el.closest("dialog")?.id ?? null, className: el.className, tag: el.tagName }
      : null;
  }, entry!.selector as string);
  expect(resolved).toEqual({ dialog: "modal-dialog", className: "counter-btn", tag: "BUTTON" });

  // …and the page never saw the click.
  await expect(page.locator("#count")).toHaveText("0");
});

/**
 * ★ The agent-initiated direction while a modal is open: the panel hosting the
 * request has to re-home into the dialog too, and its buttons have to work
 * there — otherwise the reviewer can see the request and not answer it. The
 * merge made this MORE load-bearing, not less: the prompt and the verdict
 * buttons ride in on the same element the notes list does.
 */
test("the review is usable inside the panel while a modal is open", async ({
  page,
  baseURL,
  bridge,
}) => {
  await openFixture(page, baseURL!, "modal.html", bridge);
  await page.locator("#open-modal").click();
  await expect(page.locator("#modal-dialog")).toBeVisible();

  const review = requestReview(bridge, { prompt: "Does the settings modal look right?" });

  // The panel opened itself, inside the dialog — anywhere else it would be
  // inert, and the human could read the request but never answer it.
  const panel = page.locator(PANEL);
  await expect(panel).toBeVisible();
  await expect(panel.locator(AGENT)).toContainText("Does the settings modal look right?");
  expect(await panel.evaluate((el) => el.closest("dialog")?.id ?? null)).toBe("modal-dialog");
  // The agent is genuinely blocked on the human at this point.
  expect(review.settled()).toBe(false);

  await page.locator(APPROVE).click();
  expect(await review.outcome).toMatchObject({ verdict: "approved", entries: [] });
  await expect(page.locator(AGENT)).toHaveCount(0);
});

import {
  AGENT,
  APPROVE,
  BADGE,
  CHANGES,
  CHIP,
  LIVE,
  MINIMIZE,
  PANEL,
  SUBMIT,
  armPicker,
  expect,
  openFixture,
  pickAndNote,
  requestReview,
  resolveFeedback,
  test,
} from "../helpers/fixui";

/**
 * The two things a unit test cannot prove, both in a real browser against a
 * real daemon: that the chip's count moves with nobody touching the page, and
 * that a session's one Submit button hands a whole batch to a held agent call.
 */

/**
 * ★ The reported bug: "when agent is clearing tasks plugin keeps old number
 * until it won't be clicked."
 *
 * Nothing in this test clicks the chip after the notes are left. The agent
 * removes the entries over the same route `resolve_feedback` uses, the daemon
 * announces `inbox-changed` on the page's own SSE stream, and the badge follows
 * — which is exactly the browser end no unit test can stand in for.
 */
test("the badge follows the inbox with nobody touching the page", async ({
  page,
  baseURL,
  bridge,
}) => {
  await openFixture(page, baseURL!, "basic.html", bridge);

  // Armed once: saving a note leaves the picker armed, which is what makes
  // leaving several in a row the natural gesture.
  await armPicker(page);
  await pickAndNote(page, "#save-btn", "Primary button should be brand blue");
  await pickAndNote(page, "#cancel-btn", "Cancel reads as the primary action");

  const badge = page.locator(BADGE);
  await expect(badge).toHaveText("2");

  const entries = await bridge.entries();
  expect(entries).toHaveLength(2);

  // The agent fixes one and resolves it. No user interaction from here on.
  await resolveFeedback(bridge, entries[0]!.id as string);
  await expect(badge).toHaveText("1");
  await expect(page.locator(PANEL)).toHaveCount(0); // and nothing opened by itself

  // …and the last one takes the badge away entirely.
  await resolveFeedback(bridge, entries[1]!.id as string);
  await expect(badge).toHaveCount(0);

  // Opening the panel now shows the same thing the badge already said — the
  // click is no longer what makes the count true. (Escape first: leaving a note
  // leaves the picker armed, and the chip's job while armed is to disarm it.)
  await page.keyboard.press("Escape");
  await page.locator(CHIP).click();
  await expect(page.locator(PANEL)).toContainText("No notes yet");
});

/** A burst — the agent clearing a batch — is still one settled count, and the
 *  panel the user left open repaints under them rather than closing. */
test("a batch of resolves lands as one repaint, panel open", async ({ page, baseURL, bridge }) => {
  await openFixture(page, baseURL!, "basic.html", bridge);

  await armPicker(page);
  for (const note of ["one", "two", "three"]) {
    await pickAndNote(page, "#save-btn", `note ${note}`);
  }
  await expect(page.locator(BADGE)).toHaveText("3");

  await page.keyboard.press("Escape"); // disarm; the chip opens the panel again
  await page.locator(CHIP).click();
  const panel = page.locator(PANEL);
  await expect(panel).toContainText("Saved notes (3)");

  const entries = await bridge.entries();
  await Promise.all(entries.map((entry) => resolveFeedback(bridge, entry.id as string)));

  // Still the same open panel, now empty — never closed, never reopened.
  await expect(panel).toContainText("No notes yet");
  await expect(panel).toHaveCount(1);
  await expect(page.locator(BADGE)).toHaveCount(0);
});

/**
 * ★ A session end to end. The test plays the agent — `POST /reviews` with
 * `mode:"session"` is what `start_fix_ui_session` posts — and the browser plays
 * the human, who leaves two notes and presses one button.
 */
test("a session: one Submit button hands the whole batch to the held call", async ({
  page,
  baseURL,
  bridge,
}) => {
  await openFixture(page, baseURL!, "basic.html", bridge);

  const session = requestReview(bridge, {
    prompt: "Point at anything that needs fixing",
    mode: "session",
  });

  // The session IS the notes panel: it opened itself, its header says a session
  // is running, and the agent's prompt is the first thing in it.
  const panel = page.locator(PANEL);
  await expect(panel).toBeVisible();
  await expect(panel.locator("h4")).toHaveText("Session running");
  await expect(panel.locator(AGENT)).toHaveText("Point at anything that needs fixing");
  await expect(panel.locator(LIVE)).toHaveCount(1);
  // One action, and it is not a verdict — the session is not a yes-or-no.
  await expect(panel.locator("[data-uifb-actions] button")).toHaveCount(1);
  await expect(page.locator(SUBMIT)).toHaveText("Submit");
  await expect(page.locator(APPROVE)).toHaveCount(0);
  await expect(page.locator(CHANGES)).toHaveCount(0);
  // Nothing else is floating over the page — the banner is gone for good.
  await expect(page.locator("[data-uifb-banner]")).toHaveCount(0);
  // The page armed itself, as a review does.
  expect(await page.evaluate(() => window.fixui.active)).toBe(true);
  expect(session.settled()).toBe(false);

  await pickAndNote(page, "#save-btn", "Primary button should be brand blue");
  await pickAndNote(page, "#cancel-btn", "Cancel reads as the primary action");

  // The notes are listed in the same panel, above the button that hands them
  // over — the whole reason the two surfaces became one.
  await expect(panel.locator("[data-uifb-row]")).toHaveCount(2);
  await expect(panel).toContainText("Primary button should be brand blue");

  await page.locator(SUBMIT).click();

  const outcome = await session.outcome;
  expect(outcome.verdict).toBe("submitted");
  expect(outcome.entries.map((entry) => entry.note)).toEqual([
    "Primary button should be brand blue",
    "Cancel reads as the primary action",
  ]);
  // The request is answered and gone; the panel is still there with the notes.
  await expect(page.locator(AGENT)).toHaveCount(0);
  await expect(page.locator(SUBMIT)).toHaveCount(0);
  await expect(panel).toHaveCount(1);

  // The audit trail records a session the way it records a review.
  expect(await bridge.reviews()).toMatchObject([{ verdict: "submitted" }]);

  // The next round starts on the same channel: sessions are a loop.
  const second = requestReview(bridge, { prompt: "Anything else?", mode: "session" });
  await expect(page.locator(AGENT)).toHaveText("Anything else?");

  // …and ending one without a note is a real answer, not a hang.
  await page.locator(SUBMIT).click();
  expect(await second.outcome).toMatchObject({ verdict: "submitted", entries: [] });
});

/**
 * ★ The failure mode the merge could have introduced: folding the panel away
 * takes the session with it, and the human is left on an armed page with no
 * idea an agent is blocked on them. So the collapsed header has to keep saying
 * it — in words and in a mark — and the chip has to keep saying it too.
 */
test("a minimized panel still says a session is live, and restores to it", async ({
  page,
  baseURL,
  bridge,
}) => {
  await openFixture(page, baseURL!, "basic.html", bridge);

  const session = requestReview(bridge, { prompt: "Anything to fix?", mode: "session" });
  const panel = page.locator(PANEL);
  await expect(panel.locator(AGENT)).toHaveText("Anything to fix?");

  await pickAndNote(page, "#save-btn", "Save is the wrong blue");
  await page.locator(MINIMIZE).click();

  // The body is folded away — prompt, notes and Submit with it…
  await expect(panel).toBeVisible();
  await expect(page.locator(AGENT)).toHaveCount(0);
  await expect(page.locator(SUBMIT)).toHaveCount(0);
  // …and the header still says a session is running, in words and in a mark.
  await expect(panel.locator("h4")).toHaveText("Session running");
  await expect(panel.locator(LIVE)).toBeVisible();
  // …and so does the chip: armed is perceptible on it either as the pulse or,
  // for anyone who asked for less motion, as the static ring that stands in.
  expect(
    await page
      .locator(CHIP)
      .evaluate(
        (el) => el.hasAttribute("data-uifb-pulse") || el.hasAttribute("data-uifb-static"),
      ),
  ).toBe(true);
  expect(session.settled()).toBe(false);

  // Restoring brings the whole request back, notes and all.
  await page.locator(MINIMIZE).click();
  await expect(panel.locator(AGENT)).toHaveText("Anything to fix?");
  await expect(panel).toContainText("Save is the wrong blue");

  await page.locator(SUBMIT).click();
  const outcome = await session.outcome;
  expect(outcome.verdict).toBe("submitted");
  expect(outcome.entries.map((entry) => entry.note)).toEqual(["Save is the wrong blue"]);
});

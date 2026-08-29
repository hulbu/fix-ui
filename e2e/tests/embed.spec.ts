import {
  armPicker,
  BOX,
  CHIP,
  expect,
  openFixture,
  PANEL,
  pickAndNote,
  POP,
  test,
} from "../helpers/fixui";

/**
 * The npm embed against a real bridge, in a real browser: one pick becomes one
 * v1 entry in the project's `.fix-ui.jsonl` — the contract every other part of
 * fix-ui is built on (docs/capture-format.md).
 */
test("a picked element becomes one v1 entry in the project inbox", async ({
  page,
  baseURL,
  bridge,
}) => {
  await openFixture(page, baseURL!, "basic.html", bridge);
  expect(await bridge.entries()).toEqual([]);

  // The page screams BEFORE anybody reaches for the picker: an entry saved
  // later has to carry what the page was already complaining about.
  await page.locator("#boom").click();

  await armPicker(page);
  await pickAndNote(page, "#save-btn", "Primary button should be brand blue, not grey");

  await expect.poll(async () => (await bridge.entries()).length).toBe(1);
  const [entry] = await bridge.entries();

  expect(entry).toMatchObject({
    v: 1,
    note: "Primary button should be brand blue, not grey",
    selector: "#save-btn",
    elementText: "Save",
  });
  expect(await page.locator(entry!.selector as string).textContent()).toBe("Save");
  expect(entry!.url).toContain("/basic.html");
  expect(typeof entry!.id).toBe("string");
  expect(entry!.viewport).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });

  // Wire-only: the bridge routes on `project` and strips it — the inbox's
  // location already encodes which project this is.
  expect(Object.keys(entry!)).not.toContain("project");

  const consoleErrors = entry!.consoleErrors as { message: string; count: number }[];
  expect(consoleErrors.map((error) => error.message)).toContain(
    "PricingCard: failed to load pricing data",
  );
});

/**
 * "after clicking 'save note' I have to click select picker once again."
 *
 * Three notes used to cost three trips back through the chip and the panel.
 * Measured where it is felt: the crosshair the browser actually resolves, and a
 * second pick driven with nothing but a click on the next element.
 */
test("picking survives a saved note — the next element is one click away", async ({
  page,
  baseURL,
  bridge,
}) => {
  await openFixture(page, baseURL!, "basic.html", bridge);
  await armPicker(page);
  await pickAndNote(page, "#save-btn", "Primary button should be brand blue");

  // Still armed, and the page still says so — same evidence the crosshair spec
  // below trusts, and neither the panel nor the chip was touched to get here.
  await expect(page.locator(PANEL)).toHaveCount(0);
  await expect
    .poll(() => page.locator("body").evaluate((el) => getComputedStyle(el).cursor))
    .toBe("crosshair");
  // …and the highlight is not still framing the element that was just noted.
  await expect(page.locator(BOX)).toBeHidden();

  // One click on the next element, with no re-arming in between.
  await pickAndNote(page, "#cancel-btn", "Cancel reads as the primary action");
  await expect(page.locator(POP)).toHaveCount(0);

  await expect.poll(async () => (await bridge.entries()).length).toBe(2);
  expect((await bridge.entries()).map((entry) => entry.selector)).toEqual([
    "#save-btn",
    "#cancel-btn",
  ]);

  // Escape is still the way out, and it is the one the toast now names.
  await page.keyboard.press("Escape");
  await expect.poll(() => page.locator("body").evaluate((el) => getComputedStyle(el).cursor)).toBe(
    "auto",
  );
});

/**
 * The cascade, which no unit test can prove.
 *
 * The crosshair used to be a cursor on `<body>`, and CSS resolves the cursor
 * from the element UNDER the pointer — so `#save-btn`, which declares
 * `cursor:pointer` like every button on the fixture, showed a hand while
 * picking was armed. The affordance vanished exactly where the user was most
 * likely to be aiming. jsdom does not resolve the cascade at all, so only a
 * real browser can say who won: `getComputedStyle` here is the whole point of
 * this spec.
 */
test("the crosshair beats the page's own cursor while picking", async ({
  page,
  baseURL,
  bridge,
}) => {
  await openFixture(page, baseURL!, "basic.html", bridge);

  const cursorOf = (selector: string, pseudo?: string): Promise<string> =>
    page.locator(selector).evaluate(
      (el, arg) => getComputedStyle(el, arg ?? null).cursor,
      pseudo,
    );

  // The page's own claim, before anybody arms anything.
  expect(await cursorOf("#save-btn")).toBe("pointer");

  await armPicker(page);
  await page.locator("#save-btn").hover();

  // …overruled, on the element and on its pseudo-elements (a ::before overlay
  // with its own cursor would otherwise punch through).
  expect(await cursorOf("#save-btn")).toBe("crosshair");
  expect(await cursorOf("#save-btn", "::before")).toBe("crosshair");
  // …and everything else on the page with it, not just what is hovered.
  expect(await cursorOf("body")).toBe("crosshair");

  // The picker's own UI is exempt, or it would be unusable while armed: the
  // chip is still a button.
  expect(await cursorOf(CHIP)).toBe("pointer");

  // Disarmed, the page gets its cursors back — nothing of ours is left over.
  await page.keyboard.press("Escape");
  await expect.poll(() => cursorOf("#save-btn")).toBe("pointer");
  await expect.poll(() => cursorOf("body")).toBe("auto");
});

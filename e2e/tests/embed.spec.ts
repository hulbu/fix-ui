import { armPicker, expect, openFixture, pickAndNote, test } from "../helpers/fixui";

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

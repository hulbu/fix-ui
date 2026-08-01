import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { expect, test, type Bridge } from "../helpers/fixui";

/**
 * The Chrome adapter in a real Chrome. Task 7's unit tests cover the pure
 * protocol; everything else about the extension — the MAIN-world bridge that
 * component detection needs, the closed shadow root the UI lives in, the
 * service-worker fetch proxy — only exists when Chromium is running it.
 *
 * Loaded unpacked from `extension/`, not `extension/dist/`: the manifest lives
 * at the package root and points into `dist/` (see extension/build.mjs).
 */
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionRoot = path.join(repoRoot, "extension");

/** chrome.storage.sync key and shape (extension/src/protocol.ts). */
const OPTIONS_KEY = "fixui.options.v1";

/**
 * Extensions need a persistent context, and headless needs `channel: "chromium"`
 * (Playwright's new-headless build — the old headless shell loads no
 * extensions). A failure here is an environment fact, not a product bug: the
 * spec reports it and marks itself fixme rather than passing on nothing.
 */
async function launchWithExtension(): Promise<BrowserContext> {
  return chromium.launchPersistentContext("", {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
    ],
  });
}

async function serviceWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
}

/** Point the extension at this test's bridge, and this origin at its project. */
async function configure(sw: Worker, origin: string, bridge: Bridge): Promise<void> {
  await sw.evaluate(
    async (stored: { key: string; options: { bridgeUrl: string; originMap: string } }) => {
      await chrome.storage.sync.set({ [stored.key]: stored.options });
    },
    {
      key: OPTIONS_KEY,
      options: { bridgeUrl: bridge.url, originMap: `${origin}=${bridge.project}` },
    },
  );
}

/**
 * Switch the extension on for a tab, the way the toolbar button does.
 *
 * Preferred: dispatch `chrome.action.onClicked` in the worker, which runs the
 * extension's real `onAction` — injection, tab bookkeeping, badge, streams.
 * Where the MV3 bindings expose no `dispatch`, fall back to the two
 * `executeScript` calls `onAction` itself makes: same injection, same order,
 * minus the state bookkeeping (nothing this spec asserts depends on it — the
 * content script's config lookup falls back to the origin map, which is exactly
 * what a tab with no stored state gets).
 */
async function toggleOn(sw: Worker, pageUrl: string): Promise<string> {
  return sw.evaluate(async (url: string) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === url);
    if (!tab?.id) throw new Error(`no tab at ${url} (saw ${tabs.map((t) => t.url).join(", ")})`);

    const clicked = chrome.action.onClicked as unknown as { dispatch?: (tab: unknown) => unknown };
    if (typeof clicked.dispatch === "function") {
      clicked.dispatch(tab);
      return "chrome.action.onClicked.dispatch";
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["dist/content.js"] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["dist/main-world.js"],
      world: "MAIN",
    });
    return "chrome.scripting.executeScript";
  }, pageUrl);
}

/** The picker sets `crosshair` while armed and clears it when it stops — the
 *  only state a CLOSED shadow root leaves visible to the page (and to us). */
function cursor(page: Page): Promise<string> {
  return page.evaluate(() => document.body.style.cursor);
}

test("the extension picks a React element on a page it knows nothing about", async ({
  bridge,
  baseURL,
}) => {
  let context: BrowserContext;
  try {
    context = await launchWithExtension();
  } catch (cause) {
    test.fixme(true, `chromium could not load the unpacked extension: ${String(cause)}`);
    return;
  }

  try {
    const sw = await serviceWorker(context);
    await configure(sw, new URL(baseURL!).origin, bridge);

    // No query string: this page does NOT initialize the embed. Everything that
    // follows comes from the extension.
    const url = `${baseURL}/basic.html`;
    const page = await context.newPage();
    await page.goto(url);
    expect(await page.evaluate(() => "fixui" in window)).toBe(false);

    // Which of the two paths this Chrome allowed is an environment fact worth
    // seeing in the run output — the MV3 bindings decide it, not us.
    const how = await toggleOn(sw, url);
    console.log(`extension toggled on via ${how}`);
    expect(how).toMatch(/dispatch|executeScript/);

    // Injected, configured, and armed by the toolbar gesture.
    await expect.poll(() => cursor(page)).toBe("crosshair");

    // ★ The component name is the whole MAIN-world round trip in one field: the
    // React fiber is invisible from the content script's isolated world, so
    // this only says "PricingCard" if the query crossed into the page's world
    // and the answer came back before the note was saved.
    await page.hover("#buy-btn");
    await page.click("#buy-btn");
    // The note popover lives in a CLOSED shadow root — no selector reaches it,
    // so this is the keyboard, on the textarea the picker focused for us.
    await page.keyboard.type("Buy now should read 'Start free trial'");
    await page.keyboard.press("Enter");

    await expect.poll(async () => (await bridge.entries()).length).toBe(1);
    const [entry] = await bridge.entries();
    expect(entry).toMatchObject({
      v: 1,
      note: "Buy now should read 'Start free trial'",
      selector: "#buy-btn",
      elementText: "Buy now",
      component: "PricingCard",
    });
    expect(Object.keys(entry!)).not.toContain("project");

    // ★ The chip is in that same closed shadow root, so it is clicked by
    // coordinate — the way a user does. It proves two things at once: the
    // picker recognizes its own UI through a closed root (`elementFromPoint`
    // retargets to the host), and the click is therefore NOT suppressed.
    const at = await page.evaluate(() => ({
      x: document.documentElement.clientWidth - 38,
      y: document.documentElement.clientHeight - 38,
    }));
    await page.mouse.click(at.x, at.y);
    await expect.poll(() => cursor(page)).toBe("");

    // Picking is off: the page reacts to its own clicks again.
    await page.click("#count-btn");
    await expect(page.locator("#click-count")).toHaveText("1");
    expect(await bridge.entries()).toHaveLength(1);
  } finally {
    await context.close();
  }
});

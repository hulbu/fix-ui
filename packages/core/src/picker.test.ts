import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleError, FeedbackEntry } from "./entry";
import { createPicker, type Picker, type PickerOptions, type ReviewVerdict } from "./picker";
import type { Transport } from "./transport";

const NS = "data-uifb";
const UI = `[${NS}],[${NS}-box],[${NS}-chip],[${NS}-pop],[${NS}-panel],[${NS}-toast],[${NS}-banner]`;

type FakeTransport = Transport & { created: FeedbackEntry[] };

function fakeTransport(result: { ok: boolean; queued: boolean } = { ok: true, queued: false }): FakeTransport {
  const created: FeedbackEntry[] = [];
  return {
    created,
    create: vi.fn(async (entry: FeedbackEntry) => {
      created.push(entry);
      return result;
    }),
    list: vi.fn(async () => []),
    remove: vi.fn(async () => true),
    flush: vi.fn(async () => {}),
    destroy: vi.fn(),
  };
}

/** MutationObserver callbacks land on the microtask queue. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const live: Picker[] = [];
function make(opts: PickerOptions): Picker {
  const picker = createPicker(opts);
  live.push(picker);
  return picker;
}

/** The whole pointer sequence a real click produces. */
function clickSequence(el: Element): Event[] {
  const events = ["pointerdown", "mousedown", "mouseup", "pointerup", "click"].map(
    (type) => new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: 5, clientY: 5 }),
  );
  for (const event of events) el.dispatchEvent(event);
  return events;
}

function query(selector: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector);
}

/** Toasts stack — the newest one is the reply to what just happened. */
function lastToast(): string {
  const all = document.querySelectorAll(`[${NS}-toast]`);
  return all[all.length - 1]?.textContent ?? "";
}

async function typeAndSave(note: string): Promise<void> {
  const pop = query(`[${NS}-pop]`)!;
  const textarea = pop.querySelector("textarea")!;
  textarea.value = note;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  pop.querySelector<HTMLButtonElement>(`[${NS}-save]`)!.click();
  await settle();
}

afterEach(() => {
  while (live.length > 0) live.pop()!.destroy();
  document.body.innerHTML = "";
  document.body.style.cursor = "";
});

describe("createPicker", () => {
  it("enable() mounts chip + arms; click on a page element is suppressed (pointerdown/mousedown/click all canceled) and opens the note popover", () => {
    document.body.innerHTML = `<button id="cta">Continue</button>`;
    const picker = make({ transport: fakeTransport() });

    picker.enable();

    expect(picker.active).toBe(true);
    expect(query(`[${NS}-chip]`)?.parentNode).toBe(document.body);

    const cta = query("#cta")!;
    const reachedPage: string[] = [];
    for (const type of ["pointerdown", "mousedown", "mouseup", "pointerup", "click"]) {
      cta.addEventListener(type, () => reachedPage.push(type));
    }

    const events = clickSequence(cta);

    expect(events.map((e) => `${e.type}:${e.defaultPrevented}`)).toEqual([
      "pointerdown:true",
      "mousedown:true",
      "mouseup:true",
      "pointerup:true",
      "click:true",
    ]);
    expect(reachedPage).toEqual([]);

    const pop = query(`[${NS}-pop]`);
    expect(pop).not.toBeNull();
    expect(pop!.querySelector("textarea")).not.toBeNull();
    expect(query(`[${NS}-box]`)!.style.display).toBe("block");
    expect(query(`[${NS}-tag]`)!.textContent).toContain("#cta");
  });

  it("saving a note builds an entry with selector, component, elementText, consoleErrors snapshot and calls transport.create + onSaved", async () => {
    document.body.innerHTML = `<button id="cta">Continue</button>`;
    const transport = fakeTransport();
    const consoleErrors: ConsoleError[] = [
      { message: "TypeError: x is not a function", source: "app.js", count: 3, lastAt: "2026-07-31T08:59:41.000Z" },
    ];
    const onSaved = vi.fn();
    const picker = make({
      transport,
      capture: { consoleErrors: () => consoleErrors, componentName: () => "PricingTable" },
      project: "/repo/app",
      onSaved,
    });

    picker.enable();
    clickSequence(query("#cta")!);

    // Empty (and whitespace-only) notes cannot be saved.
    const save = query(`[${NS}-pop]`)!.querySelector<HTMLButtonElement>(`[${NS}-save]`)!;
    expect(save.disabled).toBe(true);

    await typeAndSave("  make this button bigger  ");

    expect(transport.create).toHaveBeenCalledTimes(1);
    expect(transport.created[0]).toMatchObject({
      v: 1,
      note: "make this button bigger",
      selector: "#cta",
      component: "PricingTable",
      elementText: "Continue",
      consoleErrors,
      project: "/repo/app",
      url: location.href,
    });
    expect(onSaved).toHaveBeenCalledWith(transport.created[0]);
    expect(query(`[${NS}-pop]`)).toBeNull();
    expect(lastToast()).toContain("Saved (1)");
  });

  it("re-homes UI into a dialog when its open attribute appears, and back to mount when it closes", async () => {
    document.body.innerHTML = `<dialog id="modal"><button id="buy">Buy</button></dialog>`;
    const dialog = query("#modal")!;
    const picker = make({ transport: fakeTransport() });
    picker.enable();

    dialog.setAttribute("open", "");
    await settle();

    expect(query(`[${NS}-chip]`)!.parentNode).toBe(dialog);
    expect(query(`[${NS}-box]`)!.parentNode).toBe(dialog);

    // …and newly opened UI homes there too.
    clickSequence(query("#buy")!);
    expect(query(`[${NS}-pop]`)!.parentNode).toBe(dialog);

    dialog.removeAttribute("open");
    await settle();

    expect(query(`[${NS}-chip]`)!.parentNode).toBe(document.body);
    expect(query(`[${NS}-box]`)!.parentNode).toBe(document.body);
    expect(query(`[${NS}-pop]`)!.parentNode).toBe(document.body);
  });

  it("destroy() removes all listeners and DOM", async () => {
    document.body.innerHTML = `<button id="cta">Continue</button><dialog id="modal">m</dialog>`;
    const picker = make({ transport: fakeTransport() });
    picker.enable();
    clickSequence(query("#cta")!);
    expect(document.querySelectorAll(UI).length).toBeGreaterThan(0);

    picker.destroy();
    live.pop();

    expect(document.querySelectorAll(UI).length).toBe(0);
    expect(document.head.querySelectorAll(`style[${NS}]`).length).toBe(0);
    expect(picker.active).toBe(false);
    expect(document.body.style.cursor).toBe("");

    const cta = query("#cta")!;
    const reachedPage: string[] = [];
    for (const type of ["pointerdown", "mousedown", "click"]) {
      cta.addEventListener(type, () => reachedPage.push(type));
    }
    const events = clickSequence(cta);
    expect(events.some((e) => e.defaultPrevented)).toBe(false);
    expect(reachedPage).toEqual(["pointerdown", "mousedown", "click"]);

    const hotkey = new KeyboardEvent("keydown", { key: "f", code: "KeyF", altKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(hotkey);
    expect(picker.active).toBe(false);
    expect(hotkey.defaultPrevented).toBe(false);

    query("#modal")!.setAttribute("open", "");
    await settle();
    expect(document.querySelectorAll(UI).length).toBe(0);
  });

  it("startReview shows the banner with the prompt; Approve triggers onVerdict with entryIds of entries saved during the review", async () => {
    document.body.innerHTML = `<button id="cta">Continue</button>`;
    const transport = fakeTransport();
    const picker = make({ transport });
    const verdicts: ReviewVerdict[] = [];
    picker.onVerdict((v) => verdicts.push(v));

    picker.startReview({ reviewId: "rev-1", prompt: "Review the new pricing table" });

    const banner = query(`[${NS}-banner]`);
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("Review the new pricing table");
    expect(picker.active).toBe(true); // the agent's flow arms the picker itself

    clickSequence(query("#cta")!);
    await typeAndSave("tighten the spacing");

    banner!.querySelector<HTMLButtonElement>(`[${NS}-approve]`)!.click();

    expect(verdicts).toEqual([
      { reviewId: "rev-1", verdict: "approved", entryIds: [transport.created[0]!.id] },
    ]);
    expect(query(`[${NS}-banner]`)).toBeNull();
    expect(picker.active).toBe(false);
  });

  it("endReview() stands the banner down without a verdict", () => {
    const picker = make({ transport: fakeTransport() });
    const onVerdict = vi.fn();
    picker.onVerdict(onVerdict);

    picker.startReview({ reviewId: "rev-2", prompt: "Check the header" });
    picker.endReview();

    expect(query(`[${NS}-banner]`)).toBeNull();
    expect(picker.active).toBe(false);
    expect(onVerdict).not.toHaveBeenCalled();
  });

  it("a rejected create is reported as an error, not as a save", async () => {
    document.body.innerHTML = `<button id="cta">Continue</button>`;
    const transport = fakeTransport({ ok: false, queued: false });
    const onSaved = vi.fn();
    const picker = make({ transport, onSaved });

    picker.enable();
    clickSequence(query("#cta")!);
    await typeAndSave("make this bigger");

    expect(onSaved).not.toHaveBeenCalled();
    expect(lastToast()).toBe("Could not save the note");
    expect(query(`[${NS}-chip]`)!.querySelector(`[${NS}-badge]`)).toBeNull();
  });

  it("a queued create keeps the note without claiming it was saved", async () => {
    document.body.innerHTML = `<button id="cta">Continue</button>`;
    const transport = fakeTransport({ ok: false, queued: true });
    const onSaved = vi.fn();
    const picker = make({ transport, onSaved });

    picker.enable();
    clickSequence(query("#cta")!);
    await typeAndSave("make this bigger");

    expect(onSaved).not.toHaveBeenCalled();
    expect(lastToast()).toContain("queued");
    expect(query(`[${NS}-badge]`)!.textContent).toBe("1"); // the note is still the user's
  });

  it("mounts into a shadow root and still sees its own UI through the shadow boundary", () => {
    document.body.innerHTML = `<button id="cta">Continue</button><div id="host"></div>`;
    const root = query("#host")!.attachShadow({ mode: "open" });
    const picker = make({ transport: fakeTransport(), mount: root });

    picker.enable();
    const chip = root.querySelector<HTMLButtonElement>(`[${NS}-chip]`);
    expect(chip).not.toBeNull();

    // A click on our own chip must not be swallowed by the picking listeners.
    const own = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, clientX: 5, clientY: 5 });
    chip!.dispatchEvent(own);
    expect(own.defaultPrevented).toBe(false);
    expect(root.querySelector(`[${NS}-pop]`)).toBeNull();
  });
});

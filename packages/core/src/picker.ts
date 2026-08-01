import { buildSelector, getReactComponentName } from "./dom";
import { buildEntry, type ConsoleError, type FeedbackEntry } from "./entry";
import type { Transport } from "./transport";

/**
 * The picker: highlight box, note popover, saved-notes panel, chip, review
 * banner — plus the four picking mechanics the prototype paid for
 * (docs/design.md "Picking mechanics"):
 *
 *   1. modal dialogs beat z-index — top-layer popovers for the paint order,
 *   2. …but only a dialog's own subtree is interactive, so the UI RE-HOMES
 *      into the topmost open modal and back out again,
 *   3. listeners live on `window` with capture (closer to the root than any
 *      page handler on `document`),
 *   4. the whole pointer sequence is suppressed while picking, not just
 *      `click`.
 *
 * All IO is injected: the picker never touches the network except through
 * `transport`, and knows nothing about chrome.*, bundlers, or the bridge.
 */

const NS = "data-uifb";
const OWN_UI = `[${NS}-pop],[${NS}-chip],[${NS}-box],[${NS}-toast],[${NS}-panel],[${NS}-banner]`;
/** Cancelled for non-picker targets while armed — see mechanic 4. */
const SUPPRESSED = ["pointerdown", "pointerup", "mousedown", "mouseup"];
const TOAST_MS = 2600;

export interface PickerOptions {
  transport: Transport;
  /** Default `document.body`; the extension passes its shadow root. */
  mount?: Element | ShadowRoot;
  capture?: {
    consoleErrors?: () => ConsoleError[];
    componentName?: (el: Element) => string | undefined;
  };
  accent?: string;
  /** Show the floating chip. Default true — it is the primary affordance. */
  chip?: boolean;
  /** Wire-only routing hint stamped onto entries. */
  project?: string;
  onSaved?: (entry: FeedbackEntry) => void;
}

export interface ReviewRequest {
  reviewId: string;
  prompt: string;
  url?: string;
  timeoutSeconds?: number;
}

export interface ReviewVerdict {
  reviewId: string;
  verdict: "approved" | "changes";
  entryIds: string[];
}

export interface Picker {
  enable(): void;
  disable(): void;
  toggle(): void;
  destroy(): void;
  readonly active: boolean;
  /** Banner up, picker armed, entry ids tracked — the agent-initiated flow. */
  startReview(req: ReviewRequest): void;
  /** Banner down without a verdict (the `review-cancelled` path). */
  endReview(): void;
  onVerdict(cb: (v: ReviewVerdict) => void): () => void;
}

function isShadowRoot(node: Element | ShadowRoot): node is ShadowRoot {
  return typeof ShadowRoot !== "undefined" && node instanceof ShadowRoot;
}

/** `:modal` / `:popover-open` throw where they are unsupported (jsdom, older engines). */
function safeMatches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

export function createPicker(opts: PickerOptions): Picker {
  const { transport } = opts;
  const accent = opts.accent ?? "#ef5b2a";
  const showChip = opts.chip ?? true;
  const componentNameOf = opts.capture?.componentName ?? getReactComponentName;
  const mount: Element | ShadowRoot = opts.mount ?? document.body;
  // Top-layer promotion is progressive enhancement: without it the UI is a
  // plain fixed overlay, which is what old browsers (and jsdom) get.
  const supportsPopover =
    typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";

  let active = false;
  let target: Element | null = null;
  let entries: FeedbackEntry[] = [];
  let review: { reviewId: string; entryIds: string[]; armed: boolean } | null = null;
  const verdictListeners = new Set<(v: ReviewVerdict) => void>();
  const toasts = new Set<HTMLElement>();
  const toastTimers = new Set<ReturnType<typeof setTimeout>>();

  const css = `
    [${NS}-box]{position:fixed;inset:auto;margin:0;overflow:visible;
      z-index:2147483600;pointer-events:none;
      border:2px solid ${accent};border-radius:6px;
      background:${accent}14;transition:all .06s ease-out;}
    [${NS}-tag]{position:absolute;left:-2px;top:-26px;white-space:nowrap;
      background:${accent};color:#fff;font:600 11px/1.6 ui-monospace,monospace;
      padding:2px 8px;border-radius:6px 6px 6px 0;}
    [${NS}-pop]{position:fixed;inset:auto;margin:0;z-index:2147483601;width:290px;
      background:#fff;color:#1c1c1c;border:1px solid #00000022;
      border-radius:12px;box-shadow:0 16px 48px -12px #00000055;
      padding:12px;font:14px/1.4 system-ui,sans-serif;}
    [${NS}-pop] textarea{width:100%;box-sizing:border-box;resize:none;
      border:1px solid #00000026;border-radius:8px;padding:8px;
      font:14px/1.4 system-ui,sans-serif;outline-color:${accent};}
    [${NS}-pop] small{display:block;margin-top:6px;color:#00000088;}
    [${NS}-pop] button{margin-top:8px;margin-right:6px;border:0;cursor:pointer;
      border-radius:999px;padding:6px 14px;font:600 13px system-ui,sans-serif;}
    [${NS}-pop] button[disabled]{opacity:.5;cursor:default;}
    [${NS}-save]{background:${accent};color:#fff;}
    [${NS}-cancel]{background:#00000010;color:#1c1c1c;}
    [${NS}-toast]{position:fixed;inset:auto;margin:0;border:0;z-index:2147483601;
      left:50%;bottom:24px;
      transform:translateX(-50%);background:#1c1c1c;color:#fff;
      padding:8px 16px;border-radius:999px;font:600 13px system-ui,sans-serif;}
    [${NS}-chip]{position:fixed;inset:auto;margin:0;overflow:visible;
      z-index:2147483601;right:16px;bottom:16px;
      width:44px;height:44px;border-radius:999px;border:0;cursor:pointer;
      background:#1c1c1c;color:#fff;font-size:19px;box-shadow:0 8px 24px -8px #00000066;}
    [${NS}-chip][data-on]{background:${accent};}
    [${NS}-badge]{position:absolute;top:-5px;right:-5px;min-width:19px;height:19px;
      border-radius:999px;background:${accent};color:#fff;
      font:700 11px/19px system-ui,sans-serif;padding:0 4px;}
    [${NS}-panel]{position:fixed;inset:auto;margin:0;z-index:2147483601;
      right:16px;bottom:70px;
      width:320px;max-height:60vh;overflow:auto;background:#fff;color:#1c1c1c;
      border:1px solid #00000022;border-radius:14px;padding:12px;
      box-shadow:0 16px 48px -12px #00000055;font:13px/1.4 system-ui,sans-serif;}
    [${NS}-panel] h4{margin:0 0 8px;font:700 13px system-ui,sans-serif;}
    [${NS}-row]{display:flex;align-items:flex-start;gap:8px;padding:8px;
      border:1px solid #00000014;border-radius:10px;margin-bottom:6px;}
    [${NS}-row] p{margin:0;flex:1;}
    [${NS}-row] p b{display:block;font-weight:600;}
    [${NS}-row] p span{display:block;margin-top:2px;color:#00000066;
      font:11px ui-monospace,monospace;word-break:break-all;}
    [${NS}-del]{border:0;background:#00000010;color:#1c1c1c;cursor:pointer;
      width:22px;height:22px;border-radius:999px;font:600 13px/22px system-ui;
      flex:none;}
    [${NS}-del]:hover{background:${accent};color:#fff;}
    [${NS}-pick]{width:100%;border:0;cursor:pointer;border-radius:999px;
      padding:8px 14px;background:${accent};color:#fff;
      font:600 13px system-ui,sans-serif;margin-top:2px;}
    [${NS}-hint]{margin:10px 0 0;text-align:center;color:#00000088;}
    [${NS}-hint] code{background:#00000010;border-radius:6px;padding:1px 6px;
      font:600 12px ui-monospace,monospace;}
    [${NS}-banner]{position:fixed;inset:auto;margin:0;z-index:2147483601;
      left:50%;top:16px;transform:translateX(-50%);
      display:flex;align-items:center;gap:10px;
      max-width:min(660px,calc(100vw - 32px));
      background:#1c1c1c;color:#fff;border:1px solid ${accent};
      border-radius:14px;padding:10px 12px;box-shadow:0 16px 48px -12px #00000066;
      font:13px/1.4 system-ui,sans-serif;}
    [${NS}-banner] p{margin:0;flex:1;}
    [${NS}-banner] p b{display:block;font:700 11px/1.6 ui-monospace,monospace;
      color:${accent};text-transform:uppercase;letter-spacing:.04em;}
    [${NS}-banner] button{border:0;cursor:pointer;border-radius:999px;
      padding:6px 12px;font:600 12px system-ui,sans-serif;white-space:nowrap;}
    [${NS}-approve]{background:${accent};color:#fff;}
    [${NS}-changes]{background:#ffffff26;color:#fff;}
  `;

  const styles: HTMLStyleElement[] = [];
  function addStyle(root: Node): void {
    const el = document.createElement("style");
    el.setAttribute(NS, "");
    el.textContent = css;
    root.appendChild(el);
    styles.push(el);
  }
  // A shadow-root mount needs its own copy — document styles don't cross the
  // boundary — while the head copy keeps the UI styled once it re-homes into
  // a light-DOM modal dialog.
  if (isShadowRoot(mount)) addStyle(mount);
  addStyle(document.head);

  // --- Mechanics 1 + 2: top layer and re-homing ----------------------------
  // `dialog.showModal()` paints in the browser's TOP LAYER and makes
  // everything outside the dialog INERT — invisible to hit-testing. Being in
  // the top layer ourselves (popover) wins the paint order but NOT the
  // inertness: a promoted popover sits visually above the modal yet clicks
  // fall through to the dialog. The only place that is both above the modal
  // and interactive is INSIDE the dialog's subtree — so the picker re-homes
  // its UI into the topmost open modal dialog (plain fixed elements there;
  // the dialog already paints in the top layer) and back to the mount as
  // top-layer popovers when no modal is open.
  let home: Element | ShadowRoot = mount;

  function promote(el: HTMLElement | null): void {
    if (!supportsPopover || !el || !el.isConnected) return;
    try {
      if (safeMatches(el, ":popover-open")) el.hidePopover();
      el.showPopover();
    } catch {
      // detached or hidden mid-flight — harmless
    }
  }

  function demote(el: HTMLElement | null): void {
    if (!supportsPopover || !el) return;
    try {
      el.hidePopover();
    } catch {
      // already closed
    }
  }

  function topModal(): HTMLElement | null {
    // `:modal` is the exact test; where it isn't supported an open <dialog>
    // is the best available approximation.
    let open: HTMLElement[];
    try {
      open = [...document.querySelectorAll<HTMLElement>("dialog:modal")];
    } catch {
      open = [...document.querySelectorAll<HTMLElement>("dialog[open]")];
    }
    return open[open.length - 1] ?? null;
  }

  /** Put `el` in the current home with the right layering mechanism. */
  function place(el: HTMLElement | null): void {
    if (!el) return;
    if (!el.isConnected || el.parentNode !== home) home.append(el);
    if (home === mount) {
      if (supportsPopover && !el.hasAttribute("popover")) el.setAttribute("popover", "manual");
      promote(el);
    } else {
      // Inside a modal dialog: plain fixed positioning paints with the dialog
      // (top layer) and stays interactive. A closed popover would be
      // display:none, so the attribute comes off entirely.
      demote(el);
      el.removeAttribute("popover");
    }
  }

  function rehome(): void {
    const next = topModal() ?? mount;
    if (next === home) return;
    home = next;
    for (const el of [box, chip, panel, pop, banner]) place(el);
    // box visibility is inline display — restate it after the move
    if (!active) box.style.display = "none";
  }

  // Dialogs toggle the `open` attribute on showModal()/close(); watching it
  // (plus dialogs mounting/unmounting) keeps the picker on the right side of
  // the modal boundary without any user action.
  const dialogWatcher = new MutationObserver(() => rehome());
  dialogWatcher.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["open"],
  });

  // --- UI ------------------------------------------------------------------
  const box = document.createElement("div");
  box.setAttribute(`${NS}-box`, "");
  box.style.display = "none";
  const tag = document.createElement("span");
  tag.setAttribute(`${NS}-tag`, "");
  box.append(tag);
  place(box);

  let pop: HTMLDivElement | null = null;
  let chip: HTMLButtonElement | null = null;
  let panel: HTMLDivElement | null = null;
  let banner: HTMLDivElement | null = null;

  if (showChip) {
    chip = document.createElement("button");
    chip.setAttribute(`${NS}-chip`, "");
    chip.setAttribute("aria-label", "UI feedback notes");
    chip.textContent = "✛";
    // Picking active → chip stops picking; otherwise it opens the notes panel.
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (active) disable();
      else togglePanel();
    });
    place(chip);
  }

  /**
   * Hydrate saved notes from the transport (best effort). Runs at init and
   * every time the panel opens, so entries the agent already fixed and
   * removed disappear without a page reload.
   */
  async function hydrate(): Promise<void> {
    let listed: FeedbackEntry[];
    try {
      listed = await transport.list();
    } catch {
      return; // transport unreachable — keep whatever we have locally
    }
    entries = listed.filter((e) => e.id && e.note);
    updateBadge();
    renderPanel();
  }
  void hydrate();

  function updateBadge(): void {
    if (!chip) return;
    chip.querySelector(`[${NS}-badge]`)?.remove();
    if (entries.length > 0) {
      const badge = document.createElement("span");
      badge.setAttribute(`${NS}-badge`, "");
      badge.textContent = String(entries.length);
      chip.append(badge);
    }
  }

  function togglePanel(): void {
    if (panel) closePanel();
    else openPanel();
  }

  function closePanel(): void {
    panel?.remove();
    panel = null;
  }

  function openPanel(): void {
    closePopover();
    panel = document.createElement("div");
    panel.setAttribute(`${NS}-panel`, "");
    renderPanel();
    place(panel);
    place(chip); // keep the chip clickable above whatever is open
    void hydrate();
  }

  function renderPanel(): void {
    if (!panel) return;
    panel.textContent = "";

    const title = document.createElement("h4");
    title.textContent = entries.length > 0 ? `Saved notes (${entries.length})` : "UI notes";
    panel.append(title);

    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.style.color = "#00000088";
      empty.style.margin = "0 0 10px";
      empty.textContent = "No notes yet — pick an element and describe the fix.";
      panel.append(empty);
    }

    for (const entry of entries) {
      const row = document.createElement("div");
      row.setAttribute(`${NS}-row`, "");
      const text = document.createElement("p");
      const note = document.createElement("b");
      note.textContent = entry.note.length > 90 ? `${entry.note.slice(0, 90)}…` : entry.note;
      const where = document.createElement("span");
      where.textContent = entry.component ? `<${entry.component}> ${entry.selector}` : entry.selector;
      text.append(note, where);
      const del = document.createElement("button");
      del.setAttribute(`${NS}-del`, "");
      del.setAttribute("aria-label", "Delete note");
      del.textContent = "×";
      del.addEventListener("click", () => void deleteEntry(entry.id));
      row.append(text, del);
      panel.append(row);
    }

    const pick = document.createElement("button");
    pick.setAttribute(`${NS}-pick`, "");
    pick.textContent = "✛ Pick an element";
    pick.addEventListener("click", () => {
      closePanel();
      enable();
    });
    panel.append(pick);

    if (entries.length > 0) {
      const hint = document.createElement("p");
      hint.setAttribute(`${NS}-hint`, "");
      const code = document.createElement("code");
      code.textContent = "fix ui";
      hint.append("Done? Ask your agent to ", code, " and fix these.");
      panel.append(hint);
    }
  }

  async function deleteEntry(id: string): Promise<void> {
    let removed = false;
    try {
      removed = await transport.remove(id);
    } catch {
      removed = false;
    }
    if (!removed) {
      toast("Could not delete the note");
      return;
    }
    entries = entries.filter((e) => e.id !== id);
    updateBadge();
    renderPanel();
  }

  function isOwnUi(node: unknown): boolean {
    return node instanceof Element && Boolean(node.closest(OWN_UI));
  }

  /** composedPath() sees our UI even when it lives in a (closed) shadow root. */
  function fromOwnUi(e: Event): boolean {
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    return path.length > 0 ? path.some(isOwnUi) : isOwnUi(e.target);
  }

  /**
   * The element under the pointer. `elementFromPoint` is the honest hit test
   * in a browser (it respects the top layer); where it is missing the
   * capture-phase target is the same element.
   */
  function pointTarget(e: MouseEvent): Element | null {
    const at =
      typeof document.elementFromPoint === "function"
        ? document.elementFromPoint(e.clientX, e.clientY)
        : null;
    if (at && !isOwnUi(at)) return at;
    return e.target instanceof Element ? e.target : null;
  }

  function labelFor(el: Element): string {
    const component = componentNameOf(el);
    const selector = buildSelector(el);
    return component ? `<${component}> ${selector}` : selector;
  }

  function highlight(el: Element): void {
    const r = el.getBoundingClientRect();
    box.style.display = "block";
    if (home === mount && !safeMatches(box, ":popover-open")) promote(box);
    box.style.left = `${r.left - 2}px`;
    box.style.top = `${r.top - 2}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    tag.textContent = labelFor(el).slice(0, 72);
  }

  function onMove(e: MouseEvent): void {
    if (pop || fromOwnUi(e)) return;
    const el = pointTarget(e);
    if (!el) return;
    target = el;
    highlight(el);
  }

  function onClick(e: MouseEvent): void {
    if (fromOwnUi(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (pop) {
      closePopover();
      return;
    }
    const el = pointTarget(e);
    if (el) {
      target = el;
      highlight(el);
      openPopover(e.clientX, e.clientY);
    }
  }

  // Mechanic 4: while picking, the page must not react at all — blocking only
  // `click` still lets pointerdown/mousedown handlers fire (menus open,
  // buttons act). Cancelling pointerdown suppresses the derived mouse events
  // but the click still reaches onClick above.
  function suppress(e: Event): void {
    if (fromOwnUi(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      if (pop) closePopover();
      else if (active) disable();
    }
  }

  function openPopover(x: number, y: number): void {
    pop = document.createElement("div");
    pop.setAttribute(`${NS}-pop`, "");

    const textarea = document.createElement("textarea");
    textarea.rows = 3;
    textarea.placeholder = "What should change here?";
    const where = document.createElement("small");
    where.textContent = target ? labelFor(target) : "";
    const save = document.createElement("button");
    save.setAttribute(`${NS}-save`, "");
    save.textContent = "Save note";
    save.disabled = true; // an empty (or whitespace-only) note is not a note
    const cancel = document.createElement("button");
    cancel.setAttribute(`${NS}-cancel`, "");
    cancel.textContent = "Cancel";
    const hint = document.createElement("small");
    hint.textContent = "Enter to save · Esc to cancel";
    pop.append(textarea, where, save, cancel, hint);

    // Show before measuring: a closed popover is display:none (rect = 0).
    place(pop);
    const rect = pop.getBoundingClientRect();
    pop.style.left = `${Math.min(x, window.innerWidth - rect.width - 12)}px`;
    pop.style.top = `${Math.min(y + 12, window.innerHeight - rect.height - 12)}px`;

    textarea.addEventListener("input", () => {
      save.disabled = textarea.value.trim().length === 0;
    });
    textarea.addEventListener("keydown", (ke) => {
      if (ke.key === "Enter" && !ke.shiftKey) {
        ke.preventDefault();
        void submit(textarea.value);
      }
      ke.stopPropagation();
    });
    save.addEventListener("click", () => void submit(textarea.value));
    cancel.addEventListener("click", () => closePopover());
    textarea.focus();
  }

  function closePopover(): void {
    pop?.remove();
    pop = null;
  }

  async function submit(note: string): Promise<void> {
    const trimmed = note.trim();
    if (!trimmed || !target) {
      closePopover();
      return;
    }
    const el = target;
    const entry = buildEntry(
      {
        note: trimmed,
        selector: buildSelector(el),
        component: componentNameOf(el),
        elementText: el.textContent ?? undefined,
        project: opts.project,
        consoleErrors: opts.capture?.consoleErrors?.(),
      },
      {
        url: location.href,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        userAgent: navigator.userAgent,
      },
    );
    closePopover();

    let result: { ok: boolean; queued: boolean };
    try {
      result = await transport.create(entry);
    } catch {
      toast("Could not save the note");
      return;
    }
    if (!result.ok && !result.queued) {
      // Rejected at the schema boundary: nothing was sent, nothing is queued.
      toast("Could not save the note");
      return;
    }

    entries.push(entry);
    review?.entryIds.push(entry.id);
    updateBadge();
    renderPanel();
    if (result.ok) {
      toast(`Saved (${entries.length}) — tap ✛ to review`);
      opts.onSaved?.(entry);
    } else {
      // Durably queued by the transport; it retries with backoff.
      toast(`Bridge unreachable — queued (${entries.length})`);
    }
  }

  function toast(message: string): void {
    const el = document.createElement("div");
    el.setAttribute(`${NS}-toast`, "");
    el.textContent = message;
    place(el);
    toasts.add(el);
    const timer = setTimeout(() => {
      toastTimers.delete(timer);
      toasts.delete(el);
      el.remove();
    }, TOAST_MS);
    toastTimers.add(timer);
  }

  // --- Review (agent → human, docs/agent-integration.md Direction 2) -------
  function showBanner(prompt: string): void {
    closeBanner();
    banner = document.createElement("div");
    banner.setAttribute(`${NS}-banner`, "");

    const text = document.createElement("p");
    const title = document.createElement("b");
    title.textContent = "Review requested";
    // textContent, never innerHTML: the prompt is somebody else's text.
    text.append(title, prompt);

    const approve = document.createElement("button");
    approve.setAttribute(`${NS}-approve`, "");
    approve.textContent = "Approve";
    approve.addEventListener("click", (e) => {
      e.stopPropagation();
      emitVerdict("approved");
    });

    const changes = document.createElement("button");
    changes.setAttribute(`${NS}-changes`, "");
    changes.textContent = "Request changes";
    changes.addEventListener("click", (e) => {
      e.stopPropagation();
      emitVerdict("changes");
    });

    banner.append(text, approve, changes);
    place(banner);
  }

  function closeBanner(): void {
    banner?.remove();
    banner = null;
  }

  function startReview(req: ReviewRequest): void {
    endReview();
    review = { reviewId: req.reviewId, entryIds: [], armed: !active };
    showBanner(req.prompt);
    enable(); // the plugin activates itself — the human never hunts for the chip
  }

  function endReview(): void {
    const current = review;
    review = null;
    closeBanner();
    if (current?.armed) disable();
  }

  function emitVerdict(verdict: ReviewVerdict["verdict"]): void {
    const current = review;
    if (!current) return;
    const result: ReviewVerdict = {
      reviewId: current.reviewId,
      verdict,
      entryIds: [...current.entryIds],
    };
    endReview();
    for (const listener of [...verdictListeners]) listener(result);
  }

  function onVerdict(cb: (v: ReviewVerdict) => void): () => void {
    verdictListeners.add(cb);
    return () => {
      verdictListeners.delete(cb);
    };
  }

  // --- Arming (mechanic 3: window + capture) -------------------------------
  function enable(): void {
    if (active) return;
    closePanel();
    active = true;
    // window + capture runs before any page listener on document (a page's
    // own capture-phase handler — a modal opener, say — would otherwise win
    // and swallow the pick click).
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
    for (const type of SUPPRESSED) window.addEventListener(type, suppress, true);
    document.body.style.cursor = "crosshair";
    chip?.setAttribute("data-on", "");
    // Re-layer above whatever opened since the chip was first shown.
    place(chip);
    toast("Pick an element, leave a note");
  }

  function disable(): void {
    if (!active) return;
    active = false;
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKey, true);
    for (const type of SUPPRESSED) window.removeEventListener(type, suppress, true);
    document.body.style.cursor = "";
    box.style.display = "none";
    demote(box);
    chip?.removeAttribute("data-on");
    closePopover();
  }

  function toggle(): void {
    if (active) disable();
    else enable();
  }

  function onHotkey(e: KeyboardEvent): void {
    if (e.altKey && e.code === "KeyF" && !fromOwnUi(e)) {
      e.preventDefault();
      toggle();
    }
  }
  window.addEventListener("keydown", onHotkey, true);

  function destroy(): void {
    disable();
    closePanel();
    closeBanner();
    review = null;
    verdictListeners.clear();
    dialogWatcher.disconnect();
    window.removeEventListener("keydown", onHotkey, true);
    for (const timer of toastTimers) clearTimeout(timer);
    toastTimers.clear();
    for (const el of toasts) el.remove();
    toasts.clear();
    for (const style of styles) style.remove();
    styles.length = 0;
    box.remove();
    chip?.remove();
  }

  return {
    enable,
    disable,
    toggle,
    destroy,
    get active() {
      return active;
    },
    startReview,
    endReview,
    onVerdict,
  };
}

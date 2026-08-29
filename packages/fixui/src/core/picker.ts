import { buildSelector, getReactComponentName } from "./dom.js";
import { buildEntry, type ConsoleError, type FeedbackEntry } from "./entry.js";
import type { Transport } from "./transport.js";

/**
 * The picker: highlight box, note popover, saved-notes panel (which is also
 * where an agent's session or review lives), chip — plus the four picking
 * mechanics the prototype paid for (docs/design.md "Picking mechanics"):
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
const OWN_UI = `[${NS}-pop],[${NS}-chip],[${NS}-box],[${NS}-toast],[${NS}-panel]`;
/** On `<html>` exactly while picking is armed — the crosshair's only switch. */
const ARMED = `${NS}-armed`;
/** Cancelled for non-picker targets while armed — see mechanic 4. */
const SUPPRESSED = ["pointerdown", "pointerup", "mousedown", "mouseup"];
const TOAST_MS = 2600;
/**
 * The chip's edge, in every state — same white, same 2px, as the badge's own
 * ring (`BADGE_RING`). The chip needs an outline to read as a floating object
 * on an arbitrary host page, and with a white border the drop shadow is the
 * only thing separating it from a white host page, so that shadow is
 * strengthened to carry the separation alone (`CHIP_SHADOW`).
 */
const CHIP_BORDER = "#ffffff";
/**
 * The chip's glyph, in every state. `#0f172a` on the default accent `#ef5b2a`
 * is 5.3:1 — past AA for the 19px mark it draws.
 */
const CHIP_GLYPH = "#0f172a";
/**
 * The note count's disc, and its text. DARK, deliberately: the chip is the
 * accent orange in every state now (see `paintChip`), and an orange badge on an
 * orange chip is the bug that started this whole thread. White on `#0f172a` is
 * 17.9:1 — the count survives at 11px — and the dark disc is 5.3:1 against the
 * orange it overlaps, on top of the white ring below.
 */
const BADGE_BG = "#0f172a";
const BADGE_FG = "#ffffff";
/**
 * The badge's ring, in every state. It used to be the chip's own fill; white
 * separates the two discs for everyone regardless of colour vision, and — being
 * state-independent — needs no branch at all.
 */
const BADGE_RING = "#ffffff";
/**
 * The chip's resting drop shadow. A constant because the armed-with-reduced-
 * motion state restates it alongside its ring, and the two must not drift.
 */
const CHIP_SHADOW = "0 10px 28px -6px #00000080";
/** The panel's declared width, and the fallback when nothing is laid out yet. */
const PANEL_WIDTH = 320;
/** The chip's declared size, in the same fallback role. */
const CHIP_SIZE = 44;
/** How much of a dragged element must stay inside the viewport. */
const KEEP_VISIBLE = 48;
/**
 * Travel (px) before a press on the chip stops being a click. The chip is a
 * BUTTON and its click is the primary interaction — press-move-release and
 * press-release are the same three events to the browser, so this number is
 * the whole of the difference: under it the chip toggles as it always has,
 * over it the chip moves and the click that follows is swallowed.
 */
const CLICK_SLOP = 4;

/** Each selector in a comma list, plus everything inside it. */
function withDescendants(selectors: string): string {
  return selectors
    .split(",")
    .flatMap((selector) => [selector.trim(), `${selector.trim()} *`])
    .join(",");
}

/** Each selector in a comma list, scoped to the armed document. */
function whileArmed(selectors: string): string {
  return selectors
    .split(",")
    .map((selector) => `html[${ARMED}] ${selector.trim()}`)
    .join(",");
}

/**
 * The crosshair, and who is allowed to escape it.
 *
 * The cursor resolves from the element UNDER the pointer, not from an ancestor
 * — so a cursor on `<body>` is beaten by every button, link and input on the
 * page, each declaring its own. That is the affordance disappearing exactly
 * where the user is most likely to be aiming, so while armed the crosshair is
 * forced onto EVERYTHING, pseudo-elements included (a `::before` overlay with
 * its own cursor would otherwise punch through).
 *
 * `!important` is the point rather than a shortcut: this deliberately overrides
 * arbitrary author CSS the picker does not control, for the duration of a
 * gesture, and nothing weaker can outrank a page's own `!important`.
 *
 * The whole thing hangs off one attribute on `<html>`, so it applies only while
 * picking and stops the instant the attribute comes off — no rule left in the
 * sheet applying unconditionally, and nothing to unwind but the attribute.
 *
 * The exceptions are the picker's own UI, which the blanket rule would
 * otherwise make unusable — a crosshair over the Save button says "this is a
 * pick target", and it is not. Each exception is two compound selectors deep
 * against the blanket rule's one, so it wins on specificity, and restates
 * `!important` so it cannot lose to it either. Order matters where specificity
 * ties (the surfaces vs. the handles inside them): later wins.
 *
 * A shadow-root mount is untouched by all of this — a shadow tree has no `html`
 * ancestor, so none of these selectors can match inside one. That copy of the
 * sheet keeps the plain cursors declared above.
 */
const CURSOR_CSS = ((): string => {
  /** The chip is a BUTTON first (a click toggles picking) and a draggable second. */
  const buttons = `[${NS}-chip],[${NS}-panel] button,[${NS}-pop] button`;
  /** Mid-gesture, on either draggable. */
  const grabbing = `[${NS}-chip][${NS}-dragging],[${NS}-panel][${NS}-dragging] [${NS}-drag]`;
  return `
    ${whileArmed("*,*::before,*::after")},html[${ARMED}]{cursor:crosshair!important;}
    ${whileArmed(withDescendants(OWN_UI))}{cursor:default!important;}
    ${whileArmed(withDescendants(`[${NS}-drag]`))}{cursor:grab!important;}
    ${whileArmed(withDescendants(buttons))}{cursor:pointer!important;}
    ${whileArmed(withDescendants(grabbing))}{cursor:grabbing!important;}
    ${whileArmed(`[${NS}-pop] button[disabled]`)}{cursor:default!important;}
    ${whileArmed(`[${NS}-pop] textarea`)}{cursor:text!important;}
`;
})();

export interface PickerOptions {
  transport: Transport;
  /** Default `document.body`; the extension passes its shadow root. */
  mount?: Element | ShadowRoot;
  capture?: {
    consoleErrors?: () => ConsoleError[];
    componentName?: (el: Element) => string | undefined;
  };
  /** The brand colour: the highlight box, the buttons, and the chip's fill. */
  accent?: string;
  /** Show the floating chip. Default true — it is the primary affordance. */
  chip?: boolean;
  /** Wire-only routing hint stamped onto entries. */
  project?: string;
  onSaved?: (entry: FeedbackEntry) => void;
}

/**
 * Which of the two agent-initiated flows the notes panel is hosting.
 *
 * `review` is the original: the agent changed something and wants a yes or a
 * no, so the panel offers Approve / Request changes. `session` is the batched
 * one (docs/agent-integration.md "Sessions"): the agent is standing by, the
 * user points at as many things as they like, and ONE button — Submit — hands
 * the whole batch over. Same channel, same held call, same timeout; only the
 * buttons and the verdict differ.
 */
export type ReviewMode = "review" | "session";

/**
 * The whole of what a session's panel says — fixed, and never the agent's own
 * words.
 *
 * The page is the tool; the terminal is the conversation. A session's panel is
 * a small floating control, so its job is to tell the human how to drive it:
 * point, describe, submit. The agent's account of what it changed ("switched
 * the text to dark, since white on yellow was hard to read") is conversation,
 * and it belongs in the terminal where there is room for it and a history to
 * read it in.
 *
 * A review is the one exception, and it is the reason `mode` exists here: a
 * review asks a question the human cannot answer without reading it, so the
 * agent's prompt is rendered there and only there.
 */
export const SESSION_INSTRUCTION = "Point at an element, describe the fix, then press Submit.";

export interface ReviewRequest {
  reviewId: string;
  /** The agent's question. Required for a review, which is a question; ignored
   *  for a session, whose panel says the same fixed thing every time. */
  prompt?: string;
  url?: string;
  timeoutSeconds?: number;
  /** Absent means `review` — an older bridge never mentions it. */
  mode?: ReviewMode;
}

export interface ReviewVerdict {
  reviewId: string;
  /** `submitted` is a session's only answer: it carries the batch, and an empty
   *  batch is a legitimate "nothing wrong, carry on". */
  verdict: "approved" | "changes" | "submitted";
  entryIds: string[];
}

export interface Picker {
  enable(): void;
  disable(): void;
  toggle(): void;
  destroy(): void;
  readonly active: boolean;
  /** Panel open on the prompt, picker armed, entry ids tracked — the
   *  agent-initiated flow. */
  startReview(req: ReviewRequest): void;
  /** The request leaves the panel without a verdict (`review-cancelled`). */
  endReview(): void;
  onVerdict(cb: (v: ReviewVerdict) => void): () => void;
  /**
   * Re-read the inbox and repaint: the badge, and the panel if one is open.
   *
   * The count used to move only when the panel was opened, so an agent
   * resolving entries left a stale number on the chip until the user clicked
   * it. Cheap and idempotent, so the adapter can call it on any hint that the
   * inbox moved (`inbox-changed` on the review channel).
   */
  refresh(): void;
}

function isShadowRoot(node: Element | ShadowRoot): node is ShadowRoot {
  return typeof ShadowRoot !== "undefined" && node instanceof ShadowRoot;
}

/**
 * Did a person do this?
 *
 * Mechanic 2 (re-homing into the page's own modal dialog) puts the picker's UI
 * in the page's light DOM while a modal is open, where page script can find it
 * and `.click()` it. `isTrusted` is the browser's own word for "this event came
 * from a user, not from script", and it is the one thing script cannot forge —
 * so the two decisions that must be a human's (a verdict on the agent's review,
 * and committing a note) require it. Hovering, highlighting and cancelling do
 * not: they cost nothing and the check would only make the picker feel broken
 * under a test harness that synthesizes events.
 */
function isHuman(e: Event): boolean {
  return e.isTrusted;
}

/** `:modal` / `:popover-open` throw where they are unsupported (jsdom, older engines). */
function safeMatches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

/**
 * Has the user asked their machine for less motion?
 *
 * The armed chip says "live" by pulsing, and motion is exactly the channel some
 * people have switched off — at the OS, for reasons ranging from taste to
 * vestibular illness. A state you can only perceive through motion is a broken
 * state for them, so this picks which of the two indicators the chip wears
 * (`paintChip`). Read per paint, never cached: the preference can change under
 * a running page. Missing (jsdom, older engines) or throwing means "motion is
 * fine" — the pulse is the default, and it is harmless.
 */
function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
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
  // Only a shadow-root mount is "ours" wholesale — an Element mount may be
  // document.body, and treating that as picker UI would suppress every pick.
  const ownRoot: ShadowRoot | null = isShadowRoot(mount) ? mount : null;
  // Top-layer promotion is progressive enhancement: without it the UI is a
  // plain fixed overlay, which is what old browsers (and jsdom) get.
  const supportsPopover =
    typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";

  let active = false;
  let target: Element | null = null;
  let entries: FeedbackEntry[] = [];
  /**
   * Notes this picker took that the transport has not delivered yet (queued
   * for retry). `list()` can't see them — and it answers `[]` for an empty
   * inbox AND for an unreachable bridge alike — so hydration must merge them
   * back in rather than trust the listing wholesale. Losing them here would
   * tell the user their note vanished while the transport is still retrying it.
   *
   * Seeded from `transport.pending()` at construction, because this Map lives in
   * picker memory and a page reload builds a new picker with an empty one. The
   * transport restores its queue from storage, so the notes were never gone —
   * only the UI's knowledge of them was, and an empty panel after a refresh is
   * indistinguishable from having lost the lot.
   */
  const unconfirmed = new Map<string, FeedbackEntry>();
  let review: {
    reviewId: string;
    entryIds: string[];
    armed: boolean;
    mode: ReviewMode;
    /** The agent's own words, kept so every repaint of a REVIEW restates them.
     *  A session never paints this — see SESSION_INSTRUCTION. */
    prompt: string;
  } | null = null;
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
    /* A flex box centring its own content, on both axes. U+271B's metrics are
       asymmetric, so a button's default text alignment lands it visibly off
       centre — and the alternative (a padding nudge, a magic offset) is tuned
       against exactly one font stack and drifts on the next one. The zero
       padding is part of the same claim: a UA button padding would eat into
       the fixed 44px box. */
    [${NS}-chip]{position:fixed;inset:auto;margin:0;overflow:visible;
      box-sizing:border-box;z-index:2147483601;right:16px;bottom:16px;
      display:flex;align-items:center;justify-content:center;padding:0;
      width:${CHIP_SIZE}px;height:${CHIP_SIZE}px;border-radius:999px;cursor:pointer;
      touch-action:none;user-select:none;-webkit-user-select:none;
      border:2px solid ${CHIP_BORDER};
      background:${accent};color:${CHIP_GLYPH};font-size:19px;
      box-shadow:${CHIP_SHADOW};}
    [${NS}-chip][${NS}-dragging]{cursor:grabbing;}
    [${NS}-chip][${NS}-static]{box-shadow:${CHIP_SHADOW},0 0 0 3px ${accent};}
    /* A line-height of 1 so the line box is the glyph and nothing else — the
       half-leading is what the flex box would otherwise be centring. */
    [${NS}-glyph]{display:block;line-height:1;}
    /* Every mark the picker draws itself (see \`svgMark\`). \`display:block\`
       because an inline SVG sits on the text baseline, and a baseline is the
       one thing a flex box centring its own content must not be handed. */
    [${NS}-mark]{display:block;flex:none;}
    [${NS}-chip][${NS}-pulse] [${NS}-glyph]{
      animation:${NS}-glyph-pulse 1.8s ease-in-out infinite;}
    /* A count in a 19px disc — so the same flex centring as every other mark,
       and \`box-sizing:border-box\` so \`min-width\` means the disc's own width.
       Content-box was measuring the 8px of padding ON TOP of the 19px floor,
       which made a one-digit count a 27x19 oval rather than a circle. The
       padding still does its job: it is what a three-digit count grows by. */
    [${NS}-badge]{position:absolute;top:-5px;right:-5px;box-sizing:border-box;
      min-width:19px;height:19px;
      display:flex;align-items:center;justify-content:center;line-height:1;
      border-radius:999px;background:${BADGE_BG};color:${BADGE_FG};
      font:700 11px system-ui,sans-serif;padding:0 4px;
      box-shadow:0 0 0 2px ${BADGE_RING};}
    [${NS}-panel]{position:fixed;inset:auto;margin:0;z-index:2147483601;
      right:16px;bottom:70px;
      width:${PANEL_WIDTH}px;max-height:60vh;overflow:auto;background:#fff;color:#1c1c1c;
      border:1px solid #00000022;border-radius:14px;padding:12px;
      box-shadow:0 16px 48px -12px #00000055;font:13px/1.4 system-ui,sans-serif;}
    [${NS}-panel] h4{margin:0;flex:1;font:700 13px system-ui,sans-serif;}
    [${NS}-head]{display:flex;align-items:center;gap:8px;margin:0 0 8px;}
    [${NS}-panel][${NS}-minimized] [${NS}-head]{margin:0;}
    [${NS}-drag]{cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;}
    [${NS}-panel][${NS}-dragging] [${NS}-drag]{cursor:grabbing;}
    /* Two columns of dots, three rows — the standard grip, drawn by a repeated
       radial gradient so it costs no icon, no font and no markup. Muted grey:
       it is a signal, not a second title. */
    [${NS}-grip]{flex:none;width:8px;height:12px;
      background-image:radial-gradient(#94a3b8 1.1px,transparent 1.3px);
      background-size:4px 4px;background-position:0 0;}
    [${NS}-min]{flex:none;box-sizing:border-box;
      display:flex;align-items:center;justify-content:center;
      width:20px;height:20px;padding:0;border:0;border-radius:6px;cursor:pointer;
      background:transparent;color:#94a3b8;}
    [${NS}-min]:hover{background:#00000010;color:#1c1c1c;}
    [${NS}-panel][${NS}-minimized] [${NS}-min] svg{transform:rotate(180deg);}
    /* "A session is live", in the one place that survives being minimized: the
       header bar. A solid accent dot — visible on its own, with the chip's own
       pulse borrowed on top for anyone who is looking at the panel rather than
       at the chip. Reduced motion stills it below; the dot stays. */
    [${NS}-live]{flex:none;width:8px;height:8px;border-radius:999px;
      background:${accent};box-shadow:0 0 0 3px ${accent}33;
      animation:${NS}-glyph-pulse 1.8s ease-in-out infinite;}
    /* The agent's own words. A tinted block rather than a bar across the top of
       the app: it is the panel's subject line, and the notes below it are what
       the buttons at the bottom act on. */
    [${NS}-agent]{margin:0 0 10px;padding:8px 10px;border-radius:10px;
      background:${accent}14;border:1px solid ${accent}55;color:#1c1c1c;}
    /* A session's one line: how to drive the panel, not what the agent said.
       Quieter than the review block on purpose — it is standing instruction
       rather than a question waiting on an answer. */
    [${NS}-instruction]{margin:0 0 10px;color:#00000088;}
    /* Separated from the list, because that is what they act on. */
    [${NS}-actions]{display:flex;gap:6px;margin-top:10px;padding-top:10px;
      border-top:1px solid #00000014;}
    [${NS}-actions] button{flex:1;border:0;cursor:pointer;border-radius:999px;
      padding:8px 12px;font:600 13px system-ui,sans-serif;}
    [${NS}-approve],[${NS}-submit]{background:${accent};color:#fff;}
    [${NS}-changes]{background:#00000010;color:#1c1c1c;}
    [${NS}-row]{display:flex;align-items:flex-start;gap:8px;padding:8px;
      border:1px solid #00000014;border-radius:10px;margin-bottom:6px;}
    [${NS}-row] p{margin:0;flex:1;}
    [${NS}-row] p b{display:block;font-weight:600;}
    [${NS}-row] p span{display:block;margin-top:2px;color:#00000066;
      font:11px ui-monospace,monospace;word-break:break-all;}
    /* A note the bridge has not taken yet. Dashed rather than dimmed: it is not
       a lesser note, it is one still on its way — and after a reload it is the
       whole of what the panel has, so it must not look disabled. */
    [${NS}-row][${NS}-queued]{border-style:dashed;border-color:${accent}88;
      background:${accent}0a;}
    /* …and the same thing in words, since a border style is not a legend. */
    [${NS}-waiting]{display:block;margin-top:4px;color:#00000088;
      font-style:normal;font-weight:600;font-size:11px;}
    /* The chip's claim again, on the other round button. This one used to read
       \`font:600 13px/22px\` around a U+00D7, which is line-height doing the
       centring — and that only lands when the glyph's own ink happens to be
       symmetric about the baseline, which U+00D7's is not. It is a drawn mark
       now (see \`cross\`), centred by the flex box.
       \`box-sizing\` and \`padding:0\` are load-bearing, not tidiness: a host
       page's own \`button{padding:...}\` cascades into this UI, and under
       content-box that padding was widening the 22px disc into a 28x22 oval
       with the glyph shoved out of it.
       24px rather than the 22px this rule used to declare, because pinning the
       box down is what takes the accidental width away with it: on a page that
       styles its buttons this was 28 across, and the smallest control in the
       product should not come out of a centring fix narrower than it went in.
       24 is also the floor WCAG 2.2 sets for a target this shape. */
    [${NS}-del]{border:0;background:#00000010;color:#1c1c1c;cursor:pointer;
      flex:none;box-sizing:border-box;padding:0;
      display:flex;align-items:center;justify-content:center;
      width:24px;height:24px;border-radius:999px;}
    [${NS}-del]:hover{background:${accent};color:#fff;}
    /* A row, so the mark and the label are centred as one — and the mark is
       drawn rather than typeset for the same reason the delete cross is. */
    [${NS}-pick]{width:100%;box-sizing:border-box;border:0;cursor:pointer;
      display:flex;align-items:center;justify-content:center;gap:7px;
      border-radius:999px;padding:8px 14px;background:${accent};color:#fff;
      font:600 13px system-ui,sans-serif;margin-top:2px;}
    /* While an agent is waiting, the panel has exactly one primary action and
       it is the one that answers them. Picking is still available — the human
       may have pressed Escape — but two full-width accent buttons stacked on
       each other is two things claiming to be the point. */
    [${NS}-panel][${NS}-req] [${NS}-pick]{background:#00000010;color:#1c1c1c;}
    [${NS}-hint]{margin:10px 0 0;text-align:center;color:#00000088;}
    [${NS}-hint] code{background:#00000010;border-radius:6px;padding:1px 6px;
      font:600 12px ui-monospace,monospace;}
    /* "Armed" as motion, since neither the colour nor the chip's own geometry
       moves — the circle is static in every state. Only the GLYPH inside it
       pulses, and only in opacity: subtle, slow, and shallow on purpose, since
       this sits on top of somebody's app all day. The badge is a sibling of
       the glyph, not a child of it, so the count never fades with it. */
    @keyframes ${NS}-glyph-pulse{
      0%,100%{opacity:1;}
      50%{opacity:.45;}
    }
    /* The same preference the JS reads, honoured by the engine itself for the
       cases the JS cannot see it (no matchMedia, a preference that flips
       between paints). Same specificity as the rules above, stated later, so
       it wins — and it substitutes the static ring rather than leaving the
       armed chip indistinguishable from the idle one. */
    @media (prefers-reduced-motion: reduce){
      [${NS}-chip][${NS}-pulse]{box-shadow:${CHIP_SHADOW},0 0 0 3px ${accent};}
      [${NS}-chip][${NS}-pulse] [${NS}-glyph]{animation:none;}
      /* The dot is a solid mark in its own right — stilling it costs nothing. */
      [${NS}-live]{animation:none;}
    }
${CURSOR_CSS}  `;

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
  if (ownRoot) addStyle(ownRoot);
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
    for (const el of [box, chip, panel, pop]) place(el);
    // box visibility is inline display — restate it after the move
    if (!active) box.style.display = "none";
    // …and so are the dragged positions, which a re-home must not lose.
    panelDrag.apply();
    chipDrag.apply();
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

  if (showChip) {
    chip = document.createElement("button");
    chip.setAttribute(`${NS}-chip`, "");
    chip.setAttribute("aria-label", "UI feedback notes");
    // Its own element, not the chip's textContent: the armed animation targets
    // this glyph alone (opacity), so the badge — the chip's other child —
    // never fades with it.
    const glyph = document.createElement("span");
    glyph.setAttribute(`${NS}-glyph`, "");
    glyph.textContent = "✛";
    chip.append(glyph);
    // Picking active → chip stops picking; otherwise it opens the notes panel.
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      // A drag that just ended leaves a click behind — the browser fires one
      // after any press-and-release on the same element. That click belongs to
      // the drag, not to the user. Anything under CLICK_SLOP px of travel never
      // became a drag and arrives here as the click it always was.
      if (chipDrag.tookTheClick()) {
        e.preventDefault();
        return;
      }
      if (active) disable();
      else togglePanel();
    });
    place(chip);
    paintChip();
  }

  /**
   * Repaint the chip and its badge for the current state.
   *
   * The chip's COLOURS do not move: fill, glyph, border and badge are the same
   * armed and idle. Colour is IDENTITY here — this is the product's mark on
   * somebody's page all day, and a mark that changes colour is a different
   * mark. (Two earlier rounds tried to make the fill carry "armed": the accent
   * hid the badge sitting on it, and a run-green stopped the chip being the
   * chip.) The chip's own GEOMETRY doesn't move either — no scale, no halo —
   * only the glyph inside it pulses, in opacity, with a persistent ring on the
   * chip standing in for anyone who asked for less of even that.
   *
   * The colours are also in the stylesheet; restating them inline is what
   * survives a page whose own CSS is hostile (and what a test can read back).
   */
  function paintChip(): void {
    if (!chip) return;
    chip.style.backgroundColor = accent;
    // One glyph colour, one border colour — see CHIP_GLYPH and CHIP_BORDER.
    chip.style.color = CHIP_GLYPH;
    chip.style.borderColor = CHIP_BORDER;
    const still = active && prefersReducedMotion();
    chip.toggleAttribute(`${NS}-pulse`, active && !still);
    chip.toggleAttribute(`${NS}-static`, still);
    // The static substitute: an accent ring just outside the white border, so
    // armed still LOOKS different from idle without anything moving.
    chip.style.boxShadow = still ? `${CHIP_SHADOW},0 0 0 3px ${accent}` : CHIP_SHADOW;
    const badge = chip.querySelector<HTMLElement>(`[${NS}-badge]`);
    // The badge overhangs the chip's edge; a 2px WHITE ring is what separates
    // the two discs at the overlap — in either state, and readable regardless
    // of colour vision. See BADGE_RING.
    if (badge) badge.style.boxShadow = `0 0 0 2px ${BADGE_RING}`;
  }

  /**
   * How many hydrations have been started. A refresh can arrive while an
   * earlier one is still waiting on the network (an agent resolving entries
   * one after another), and the older answer describes an older inbox — so
   * only the newest read is allowed to land.
   */
  let hydrations = 0;

  /**
   * Hydrate saved notes from the transport (best effort). Runs at init, every
   * time the panel opens, and on any hint that the inbox moved (`refresh`), so
   * entries the agent already fixed and removed disappear without a page
   * reload — and without the user clicking anything.
   */
  async function hydrate(): Promise<void> {
    const ticket = (hydrations += 1);
    let listed: FeedbackEntry[];
    try {
      listed = await transport.list();
    } catch {
      return; // a custom transport threw — keep whatever we have locally
    }
    if (ticket !== hydrations) return; // a newer read is already on its way
    const known = listed.filter((e) => e.id && e.note);
    // Anything the inbox now reports is confirmed and stops being ours to keep.
    for (const entry of known) unconfirmed.delete(entry.id);
    entries = [...known, ...unconfirmed.values()];
    updateBadge();
    renderPanel();
  }

  /**
   * Put the transport's undelivered notes back before anything else happens.
   *
   * Synchronous and first, so the badge is right on the paint after a reload
   * rather than after a round trip to a bridge that — by the very fact these
   * entries are still queued — is probably not answering. `hydrate()` then
   * merges the inbox on top and drops whatever the bridge has since confirmed.
   */
  function seedUnconfirmed(): void {
    let queued: FeedbackEntry[];
    try {
      // Optional at runtime even though the interface requires it: `transport`
      // is a public seam, and a hand-written one from an older release must
      // degrade to today's behaviour rather than throw on construction.
      queued = typeof transport.pending === "function" ? transport.pending() : [];
    } catch {
      return; // a custom transport threw — nothing to restore
    }
    for (const entry of queued) {
      if (entry.id && entry.note) unconfirmed.set(entry.id, entry);
    }
    if (unconfirmed.size === 0) return;
    entries = [...unconfirmed.values()];
    updateBadge();
  }
  seedUnconfirmed();
  void hydrate();

  function updateBadge(): void {
    if (!chip) return;
    chip.querySelector(`[${NS}-badge]`)?.remove();
    if (entries.length > 0) {
      const badge = document.createElement("span");
      badge.setAttribute(`${NS}-badge`, "");
      // A count means the same thing armed or idle, so it looks the same either
      // way: one orange, dark text, never the chip's state colour.
      badge.style.backgroundColor = BADGE_BG;
      badge.style.color = BADGE_FG;
      badge.textContent = String(entries.length);
      chip.append(badge);
    }
    paintChip();
  }

  /**
   * Collapsed to its header bar. Kept for the page's lifetime like the dragged
   * position, and for the same reason: the user put it that way on purpose, and
   * un-minimizing on every reopen would undo the decision they just made.
   */
  let minimized = false;

  function togglePanel(): void {
    if (panel) closePanel();
    else openPanel();
  }

  function closePanel(): void {
    panelDrag.stop();
    panel?.remove();
    panel = null;
  }

  function openPanel(): void {
    closePopover();
    panel = document.createElement("div");
    panel.setAttribute(`${NS}-panel`, "");
    renderPanel();
    place(panel);
    panelDrag.apply(); // where the user last put it, if anywhere
    place(chip); // keep the chip clickable above whatever is open
    void hydrate();
  }

  // --- Dragging (the panel by its header, the chip by itself) --------------
  function pointerIdOf(e: Event): number {
    return "pointerId" in e && typeof e.pointerId === "number" ? e.pointerId : 0;
  }

  interface DragSpec {
    /** Read live: the panel comes and goes, and both can be re-homed. */
    el: () => HTMLElement | null;
    /** Declared width — the fallback when nothing is laid out yet (jsdom). */
    width: number;
    /**
     * Travel before a press becomes a drag. The panel's header is not a
     * control, so every press there is a drag straight away (0). The chip IS
     * the primary control, so its press only becomes a drag past `CLICK_SLOP`
     * — and the click a real drag leaves behind is then answered for once by
     * `tookTheClick()`.
     */
    slop: number;
    /** A grab that starts on a control is that control's, not the drag's. */
    guardControls: boolean;
  }

  /**
   * One drag, two draggables. Both park in a corner, on top of whatever the
   * user was trying to look at, and both must be movable without any of it
   * leaking into picking or into the page — so the position lives in memory
   * (`localStorage` is not something core may assume: a sandboxed iframe throws
   * on merely touching it, and a chip position is not worth that failure mode),
   * the listeners live on `window` in the capture phase (the same place the
   * picker's own suppression lives), and every event the gesture touches stops
   * there.
   */
  function draggable(spec: DragSpec) {
    /** Where the user put it, in viewport coordinates — the page's lifetime. */
    let pos: { left: number; top: number } | null = null;
    let drag: {
      pointerId: number;
      dx: number;
      dy: number;
      fromX: number;
      fromY: number;
      moved: boolean;
    } | null = null;
    let swallowClick = false;

    /** Move it, but never fully out of reach. */
    function apply(): void {
      const el = spec.el();
      if (!el || !pos) return;
      const width = el.getBoundingClientRect().width || spec.width;
      const left = Math.min(
        Math.max(pos.left, KEEP_VISIBLE - width),
        window.innerWidth - KEEP_VISIBLE,
      );
      // Never above the viewport's top edge: the handle rides the top edge, and
      // a handle dragged past it could never be grabbed again.
      const top = Math.min(Math.max(pos.top, 0), window.innerHeight - KEEP_VISIBLE);
      pos = { left, top };
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      // The sheet parks both in a corner; those would fight left/top.
      el.style.right = "auto";
      el.style.bottom = "auto";
    }

    function onStart(e: MouseEvent): void {
      const el = spec.el();
      if (!el || drag) return;
      if (e.button > 0) return; // the primary button only — no context menus
      if (spec.guardControls && e.target instanceof Element && e.target.closest("button")) return;
      const rect = el.getBoundingClientRect();
      drag = {
        pointerId: pointerIdOf(e),
        dx: e.clientX - (pos?.left ?? rect.left),
        dy: e.clientY - (pos?.top ?? rect.top),
        fromX: e.clientX,
        fromY: e.clientY,
        moved: spec.slop === 0,
      };
      swallowClick = false;
      // The page never learns about the gesture either way. What differs is
      // preventDefault: on the panel it is what stops the browser selecting the
      // header text, but on the chip it would also cancel the press's own
      // default behaviours (focus, and on some engines the click itself), so
      // there it waits until the press has actually become a drag.
      e.stopPropagation();
      if (drag.moved) e.preventDefault();
      // Capture keeps a fast drag on the element even when the pointer outruns it.
      if (typeof el.setPointerCapture === "function") {
        try {
          el.setPointerCapture(drag.pointerId);
        } catch {
          // unsupported id (a synthesized event) — the window listeners suffice
        }
      }
      el.setAttribute(`${NS}-dragging`, "");
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onEnd, true);
      window.addEventListener("pointercancel", onEnd, true);
    }

    function onMove(e: MouseEvent): void {
      if (!drag || !spec.el() || pointerIdOf(e) !== drag.pointerId) return;
      e.stopPropagation();
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.fromX, e.clientY - drag.fromY) <= spec.slop) return;
        drag.moved = true;
        // Past the threshold this is a drag, so the click the browser fires
        // when the pointer comes up is the drag's to answer for.
        swallowClick = true;
      }
      e.preventDefault();
      pos = { left: e.clientX - drag.dx, top: e.clientY - drag.dy };
      apply();
    }

    function onEnd(e: MouseEvent): void {
      if (!drag || pointerIdOf(e) !== drag.pointerId) return;
      e.stopPropagation();
      stop();
    }

    function stop(): void {
      if (!drag) return;
      const { pointerId } = drag;
      drag = null;
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onEnd, true);
      window.removeEventListener("pointercancel", onEnd, true);
      const el = spec.el();
      if (el) {
        el.removeAttribute(`${NS}-dragging`);
        try {
          el.releasePointerCapture?.(pointerId);
        } catch {
          // never captured — nothing to release
        }
      }
    }

    return {
      apply,
      stop,
      onStart: onStart as EventListener,
      /**
       * "That click was mine" — asked once, by the chip's click handler, for
       * the click a finished drag leaves behind. Anything that never crossed
       * the threshold answers false and is handled as the click it is.
       */
      tookTheClick(): boolean {
        const was = swallowClick;
        swallowClick = false;
        return was;
      },
    };
  }

  const panelDrag = draggable({
    el: () => panel,
    width: PANEL_WIDTH,
    slop: 0,
    guardControls: true,
  });
  /** The chip is its own handle — and its own primary control, hence the slop. */
  const chipDrag = draggable({
    el: () => chip,
    width: CHIP_SIZE,
    slop: CLICK_SLOP,
    guardControls: false,
  });
  chip?.addEventListener("pointerdown", chipDrag.onStart);

  /**
   * A mark the picker draws itself: no icon package, no icon font, no emoji.
   *
   * Drawn rather than typeset because that is the only way the INK is centred
   * and not merely the box around it. `system-ui` is a different font on every
   * platform, and a glyph's ink sits wherever that font's metrics put it —
   * U+00D7 rides high in most of them, which is exactly why the delete button
   * looked broken while its CSS looked reasonable. A path in a square viewBox
   * has no metrics to be at the mercy of: every mark below is symmetric about
   * the viewBox centre once the round cap adds `stroke-width / 2` at each end,
   * so a flex box centring the SVG centres what the user actually sees.
   *
   * Every `d` is absolute `M x y L x y` points only — the extents are then the
   * points themselves, which is what lets a unit test check that symmetry
   * without a browser (picker.test.ts, "every mark is centred by layout, never
   * by line-height"). The browser measures the result for real in
   * e2e/tests/icons.spec.ts, which is the assertion that catches this class of
   * bug before a human has to notice it.
   */
  function svgMark(size: number, strokeWidth: number, paths: string[]): SVGSVGElement {
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute(`${NS}-mark`, "");
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    // Decorative in every case: each of these sits inside a control that
    // already carries its own accessible name.
    svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
      const path = document.createElementNS(svgNs, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", String(strokeWidth));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.append(path);
    }
    return svg;
  }

  /**
   * A downward chevron. CSS flips it when the panel is minimized rather than
   * swapping in a second mark — it is the same control, pointing the other way.
   *
   * The vertical points are 5.25 and 8.75, not 5.5 and 9: the round cap grows
   * the ink by 0.9 at each end, and only these two put the result's centre on
   * the viewBox's own centre of 7.
   */
  function chevron(): SVGSVGElement {
    return svgMark(14, 1.8, ["M3.5 5.25L7 8.75L10.5 5.25"]);
  }

  /**
   * Delete. Two crossed strokes rather than U+00D7: a multiplication sign is
   * optically light at this size, it is the glyph whose high-riding ink made
   * this control look damaged in the first place, and — being a character —
   * it renders as whatever `system-ui` resolves to on the platform. A drawn
   * cross is the same weight as the chevron above it on every one of them.
   */
  function cross(): SVGSVGElement {
    return svgMark(12, 1.7, ["M3.4 3.4L8.6 8.6", "M8.6 3.4L3.4 8.6"]);
  }

  /**
   * The picker's own mark — the open-centre cross the chip wears, drawn at the
   * size the Pick button needs it.
   */
  function pickMark(): SVGSVGElement {
    return svgMark(13, 1.9, [
      "M6.5 1L6.5 4.3",
      "M6.5 8.7L6.5 12",
      "M1 6.5L4.3 6.5",
      "M8.7 6.5L12 6.5",
    ]);
  }

  /**
   * Repaint the panel in place, keeping the user where they were.
   *
   * A render can now happen without the user asking for one — an agent
   * resolving an entry repaints the list underneath them — and rebuilding the
   * children resets `scrollTop` to zero, which mid-scroll reads as the panel
   * jumping out from under the pointer. The panel object itself is never
   * replaced, so nothing else about the open panel (its dragged position, the
   * minimized state) is at risk.
   */
  function renderPanel(): void {
    if (!panel) return;
    const scrolled = panel.scrollTop;
    paintPanel();
    if (scrolled > 0 && panel.scrollTop !== scrolled) panel.scrollTop = scrolled;
  }

  function paintPanel(): void {
    if (!panel) return;
    panel.textContent = "";
    panel.toggleAttribute(`${NS}-minimized`, minimized);
    // "An agent is waiting on this panel" — what the quieter Pick button hangs
    // off, and true whether or not the panel is folded away.
    panel.toggleAttribute(`${NS}-req`, review !== null);

    // The whole header is the drag handle — rows and their buttons stay rows
    // and buttons, so deleting a note can never turn into a drag. A re-render
    // mid-drag replaces this handle but not the panel, and the drag's own
    // listeners live on `window` and move the panel, so a drag in flight
    // survives it.
    const head = document.createElement("div");
    head.setAttribute(`${NS}-head`, "");
    head.setAttribute(`${NS}-drag`, "");
    head.addEventListener("pointerdown", panelDrag.onStart);

    // Two columns of dots: the header was draggable before this and nothing
    // said so. Decorative — the header is the target, and a name for the grip
    // would only be a second, wronger name for the header.
    const grip = document.createElement("span");
    grip.setAttribute(`${NS}-grip`, "");
    grip.setAttribute("aria-hidden", "true");

    // While an agent is waiting, the header says so — because the header is
    // ALL that is left when the panel is minimized, and a live session hidden
    // behind a collapse is the failure this whole merge exists to avoid.
    const title = document.createElement("h4");
    title.textContent = review
      ? review.mode === "session"
        ? "Session running"
        : "Review requested"
      : entries.length > 0
        ? `Saved notes (${entries.length})`
        : "UI notes";

    // Not an X. Closing is the scarier promise ("is my note gone?"); what the
    // user wants when the panel covers the thing they are reviewing is to put
    // it aside. Minimizing is this panel's display and nothing else's — the
    // picker, the notes and the chip are all untouched.
    const minimize = document.createElement("button");
    minimize.setAttribute(`${NS}-min`, "");
    minimize.setAttribute("aria-label", minimized ? "Restore notes panel" : "Minimize notes panel");
    minimize.append(chevron());
    minimize.addEventListener("click", (e) => {
      e.stopPropagation();
      minimized = !minimized;
      renderPanel();
      panelDrag.apply(); // a header-height panel must not fall off the clamp
    });

    head.append(grip);
    // The second half of "still obviously live": a mark, for the glance that
    // does not read the title. Decorative — the title already says it in words.
    if (review) {
      const live = document.createElement("span");
      live.setAttribute(`${NS}-live`, "");
      live.setAttribute("aria-hidden", "true");
      head.append(live);
    }
    head.append(title, minimize);
    panel.append(head);
    // Minimized IS the header bar — and it stays wherever it was dragged to.
    if (minimized) return;

    // What the panel is for, at the top of it — and which of the two it says is
    // the whole difference between the modes.
    //
    // A REVIEW restates the agent's prompt: it asked a question, and a question
    // you cannot read is a question you cannot answer.
    //
    // A SESSION says the same fixed line every time. The agent's report of what
    // it changed goes to the terminal (skills/fix-ui/SKILL.md, "Reporting");
    // rendering it here turned a 290px control into a message surface, restating
    // prose the human had already read in the conversation they were having.
    if (review?.mode === "session") {
      const how = document.createElement("p");
      how.setAttribute(`${NS}-instruction`, "");
      how.textContent = SESSION_INSTRUCTION;
      panel.append(how);
    } else if (review) {
      const agent = document.createElement("p");
      agent.setAttribute(`${NS}-agent`, "");
      // textContent, never innerHTML: the prompt is somebody else's text.
      agent.textContent = review.prompt;
      panel.append(agent);
    }

    // "No notes yet — pick an element and describe the fix" is the instruction
    // above, worded twice; a session shows one of them, and it is the one that
    // also names the button.
    if (entries.length === 0 && review?.mode !== "session") {
      const empty = document.createElement("p");
      empty.style.color = "#00000088";
      empty.style.margin = "0 0 10px";
      empty.textContent = "No notes yet — pick an element and describe the fix.";
      panel.append(empty);
    }

    for (const entry of entries) {
      const row = document.createElement("div");
      row.setAttribute(`${NS}-row`, "");
      // Still ours, not the bridge's. A restored note looks exactly like a saved
      // one otherwise, and "saved" would be a claim nobody has made yet.
      const waiting = unconfirmed.has(entry.id);
      row.toggleAttribute(`${NS}-queued`, waiting);
      const text = document.createElement("p");
      const note = document.createElement("b");
      note.textContent = entry.note.length > 90 ? `${entry.note.slice(0, 90)}…` : entry.note;
      const where = document.createElement("span");
      where.textContent = entry.component ? `<${entry.component}> ${entry.selector}` : entry.selector;
      text.append(note, where);
      if (waiting) {
        // In words as well as in colour: the marker has to survive a reader who
        // cannot tell the dashed border from the solid one.
        const mark = document.createElement("em");
        mark.setAttribute(`${NS}-waiting`, "");
        mark.textContent = "Queued — waiting for the bridge";
        text.append(mark);
      }
      const del = document.createElement("button");
      del.setAttribute(`${NS}-del`, "");
      del.setAttribute("aria-label", "Delete note");
      del.append(cross());
      del.addEventListener("click", () => void deleteEntry(entry.id));
      row.append(text, del);
      panel.append(row);
    }

    const pick = document.createElement("button");
    pick.setAttribute(`${NS}-pick`, "");
    // The mark is its own element beside the label rather than a character in
    // front of it: a literal "✛ " is read out by a screen reader, and the space
    // between it and the label is whatever the font says it is.
    const pickLabel = document.createElement("span");
    pickLabel.textContent = "Pick an element";
    pick.append(pickMark(), pickLabel);
    pick.addEventListener("click", () => {
      // Normally the panel gets out of the way of the thing being picked. Not
      // during a session: the prompt and the button that ends it live in here,
      // and closing the panel would take the agent's question off the screen.
      if (!review) closePanel();
      enable();
    });
    panel.append(pick);

    if (entries.length > 0 && !review) {
      const hint = document.createElement("p");
      hint.setAttribute(`${NS}-hint`, "");
      const code = document.createElement("code");
      code.textContent = "fix ui";
      hint.append("Done? Ask your agent to ", code, " and fix these.");
      panel.append(hint);
    }

    // Last, and deliberately so: they act on the notes listed above them, and
    // that is exactly what the reading order should say. (The hint above is
    // suppressed while one is up — "ask your agent to fix ui" is the wrong
    // advice when an agent is already holding a call open on this very list.)
    if (review) {
      const actions = document.createElement("div");
      actions.setAttribute(`${NS}-actions`, "");
      // A session is not a yes-or-no question, so it does not ask one: the user
      // leaves as many notes as they like and hands the batch over with Submit.
      actions.append(
        ...(review.mode === "session"
          ? [verdictButton("submit", "Submit", "submitted")]
          : [
              verdictButton("approve", "Approve", "approved"),
              verdictButton("changes", "Request changes", "changes"),
            ]),
      );
      panel.append(actions);
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
    unconfirmed.delete(id);
    updateBadge();
    renderPanel();
  }

  function isOwnUi(node: unknown): boolean {
    // A CLOSED shadow tree is invisible to listeners outside it: composedPath()
    // omits its nodes and retargets to the host, which carries none of our
    // attributes. The root and its host therefore count as our UI outright —
    // without this, picking would suppress clicks on our own chip and panel.
    if (ownRoot !== null && (node === ownRoot || node === ownRoot.host)) return true;
    return node instanceof Element && Boolean(node.closest(OWN_UI));
  }

  /** True for anything that happened inside the picker's own UI. */
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
      if (ke.key === "Enter" && !ke.shiftKey && isHuman(ke)) {
        ke.preventDefault();
        void submit(textarea.value);
      }
      ke.stopPropagation();
    });
    save.addEventListener("click", (e) => {
      if (!isHuman(e)) return;
      void submit(textarea.value);
    });
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

    let result: { ok: boolean; queued: boolean; error?: string };
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
    if (!result.ok) unconfirmed.set(entry.id, entry); // queued: the inbox hasn't got it yet
    updateBadge();
    renderPanel();
    if (result.ok) {
      toast(`Saved (${entries.length}) — tap ✛ to review`);
      opts.onSaved?.(entry);
    } else if (result.error !== undefined) {
      // The endpoint answered and said why (an unwritable inbox names the path
      // it tried). Verbatim, per docs/design.md "Error handling" — "bridge
      // unreachable" would be a lie AND would hide the path. Still queued.
      toast(result.error);
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

  /**
   * One of the panel's action buttons. Every one of them ends a held agent
   * call, which is a decision that has to be a human's — hence `isHuman` on all
   * three (see the note on that function): Submit is exactly as much of a
   * decision as Approve. It matters more, not less, now that these buttons live
   * in the panel: the panel re-homes into the page's own modal dialog, which
   * puts them in light DOM that page script can find and `.click()`.
   */
  function verdictButton(
    attribute: string,
    label: string,
    verdict: ReviewVerdict["verdict"],
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.setAttribute(`${NS}-${attribute}`, "");
    button.textContent = label;
    button.addEventListener("click", (e) => {
      if (!isHuman(e)) return;
      e.stopPropagation();
      emitVerdict(verdict);
    });
    return button;
  }

  /**
   * The agent's request opens the notes panel and lives in it.
   *
   * It used to be a third floating element — a 660px bar across the top of
   * somebody's app, beside the chip and beside the panel whose list it was
   * asking about. One surface is the honest shape: the prompt is the panel's
   * subject line, the notes are the panel's list, and the buttons at the bottom
   * hand that list over. Everything the panel already does — dragging,
   * minimizing, re-homing into an open modal, repainting in place without
   * losing the scroll — now applies to the review for free.
   */
  function startReview(req: ReviewRequest): void {
    // The bridge replays `review-requested` to every new subscriber, so a
    // dropped stream (an SSE reconnect, the extension's worker reviving) calls
    // this again for the review already running. That is a RESUME, not a new
    // review: rebuilding the state would throw away the ids of notes taken so
    // far and report `changes` with nothing to act on — the one verdict pair
    // the agent cannot use.
    const resumed = review?.reviewId === req.reviewId ? review : null;
    if (!resumed) endReview(); // a different review: stand the old one down first
    review = resumed ?? {
      reviewId: req.reviewId,
      entryIds: [],
      armed: !active,
      // A bridge that never mentions a mode is asking for the original review.
      mode: req.mode ?? "review",
      prompt: req.prompt ?? "",
    };
    // A resume may restate the prompt; the ids it has already collected stay.
    review.prompt = req.prompt ?? "";
    // A NEW request has to be readable the moment it arrives — a panel the user
    // folded away an hour ago would otherwise hide the question. A RESUME is
    // left alone: if it is minimized, the human minimized it during this very
    // session, on purpose, and the header still says the session is live.
    if (!resumed) minimized = false;
    enable(); // the plugin activates itself — the human never hunts for the chip
    // …and the panel comes up with it, carrying the prompt and the buttons.
    if (panel) renderPanel();
    else openPanel();
  }

  function endReview(): void {
    const current = review;
    review = null;
    if (current?.armed) disable();
    // The prompt and its buttons go; the notes, and the panel, stay.
    renderPanel();
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
    // The panel is normally in the way of the thing being picked — except when
    // it is hosting the agent's request, which is the reason picking started.
    if (!review) closePanel();
    active = true;
    // window + capture runs before any page listener on document (a page's
    // own capture-phase handler — a modal opener, say — would otherwise win
    // and swallow the pick click).
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
    for (const type of SUPPRESSED) window.addEventListener(type, suppress, true);
    // The whole cursor story, in one attribute — see CURSOR_CSS. Not a cursor
    // on <body>: that one is beaten by every element that declares its own.
    document.documentElement.setAttribute(ARMED, "");
    chip?.setAttribute("data-on", "");
    // Same orange, now pulsing (or ringed, where motion is unwelcome).
    paintChip();
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
    document.documentElement.removeAttribute(ARMED);
    box.style.display = "none";
    demote(box);
    chip?.removeAttribute("data-on");
    paintChip();
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
    // Belt and braces: `disable()` is a no-op when the picker was never armed,
    // and destroy() must leave nothing of ours on the document either way.
    document.documentElement.removeAttribute(ARMED);
    // Also ends the panel drag and drops its window listeners — and takes the
    // agent's request with it, since the panel is where that lives now.
    closePanel();
    chipDrag.stop(); // …and the chip's, if the page went away mid-gesture
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
    refresh() {
      void hydrate();
    },
  };
}

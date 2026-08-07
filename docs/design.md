# fix-ui — design

2026-07-31 · status: **built, v1** — core, the npm embed, the Chrome
extension and the bridge are implemented and tested (see the repo README
for how to run them). Extracted from the working prototype in
`hulbu/tools/ui-feedback` (`src/core.ts` picker + entry schema, `src/dom.ts`
selector builder + React component detection, `src/dom.test.ts` its suite;
reference sink: `website/src/app/api/ui-feedback/route.ts`). The docs are
self-sufficient — the prototype is provenance and reusable code, not
required reading.

## Goals

- Turn "this looks wrong" into an agent-actionable item in under five
  seconds, without leaving the page.
- Serve two delivery modes with one behavior: an npm embed for apps you
  own, a browser extension for everything else.
- First-class Claude Code; agent-agnostic protocol (anything that can read
  a file or speak MCP can participate).

Non-goals (v1): screenshots by default (token cost — opt-in flag later),
session replay, multi-user feedback aggregation, hosted service. YAGNI.

## Components

Since the consolidation these are three module trees inside one published
package, `fixui` — `packages/fixui/src/{core,embed,bridge}`. The boundaries
below are still real and still enforced (by the import graph, and by the two
tsc projects the package builds under); what went away is the *publishing*
topology, where three tarballs pinned each other by version.

### `src/core` — the picker engine

What it does: everything shared — element picking state machine, selector
building, React/framework component-name detection, the entry schema and
its validation, the transport client (POST to bridge or custom endpoint),
console-error ring buffer.

How you use it: adapters call `createPicker({ mount, transport, capture })`
and get `enable/disable/destroy`; the core emits `entry` objects and never
talks to the network except through the injected `transport`.

Depends on: nothing at runtime (zero-dependency; the prototype already is).

Boundary rule: core knows *nothing* about chrome.* APIs, Next.js, or the
bridge's filesystem — that's what keeps the embed and extension from
diverging.

### `src/embed` — the npm adapters

What it does: mounts core's picker UI into the host page (chip, highlight,
note popover, saved-notes panel). Dev-builds only by convention.

How you use it: `initFixUi({ endpoint })` in the app's dev entry; or a
framework helper (`<FixUi />` for React) that no-ops in production.

Depends on: core. Inherits the page's DOM reality — see "Picking mechanics"
for the modal/inert handling it must keep.

### fix-ui extension (Chrome, MV3)

What it does: injects core's picker into any page via a content script;
UI lives in a closed shadow root in the isolated world so page CSS can't
touch it. A tiny MAIN-world script reads framework internals (component
names) and forwards them via postMessage. Console errors come from a
MAIN-world `window.onerror`/`console.error` wrap, buffered in the content
script.

How you use it: install once; the toolbar action toggles picking on the
active tab; options page sets the bridge URL (default localhost).

Depends on: core + chrome extension APIs. The extension's honest advantage
over the embed is *reach* (any site, no code changes) — not layering. An
injected content script lives in the same DOM as the page, so it fights
the same top-layer/inert battles (below). If a later version wants
DevTools-grade overlay picking that ignores page CSS entirely, that is the
`chrome.debugger` API (inspect-mode overlay) at the cost of Chrome's "this
tab is being debugged" banner — documented as a possible v2 mode, not v1.

### `src/bridge` — the daemon behind the `fixui` bin

What it does: single local daemon, loopback-only, default
`http://127.0.0.1:3499`.
- HTTP: `POST /entries` (create), `GET /entries` (list), `DELETE
  /entries/:id` — same shape the prototype's Next.js route exposes today
  (the bridge also accepts the prototype's body-style `DELETE /entries`
  `{ id }`, so one transport client works bridge-less against an
  app-provided endpoint). Plus the review channel: `GET /events` (SSE to
  adapters) and `POST /reviews/:id/verdict` — spec in
  agent-integration.md.
- Storage: appends to `.fix-ui.jsonl` in the target project directory
  (per-project routing by the wire-level `project` field — see
  capture-format.md — or the bridge's cwd).
- MCP server for agents: see agent-integration.md.
- Review broker: holds pending `request_review` / `start_fix_ui_session`
  calls open and pairs them with a connected adapter over SSE (one-way push
  is all it needs — verdicts return as plain POSTs) — the human-in-the-loop
  channel. The same stream carries `inbox-changed`, so a page's note count
  follows the inbox instead of only refreshing when its panel is opened.

One daemon, many projects: the first `fixui-bridge` binds :3499 and owns
the inbox files; later instances (each Claude Code session spawns its own
via stdio MCP) detect the bound port and proxy to it, scoping their MCP
calls to their own cwd's project.

Depends on: node stdlib + an MCP SDK. No database; the inbox JSONL is the
queue (resolved entries are removed, no tombstones — reviews get their
own append-only record, see capture-format.md).

## Picking mechanics — lessons the prototype paid for

These are requirements, not trivia; each one shipped as a fix in
`hulbu/tools/ui-feedback` first:

1. **Modal dialogs beat z-index.** `dialog.showModal()` paints in the
   browser top layer above any z-index. Being in the top layer yourself
   (`popover="manual"` + `showPopover()`) wins the paint order…
2. **…but not interactivity: everything outside a modal is inert.** A
   popover promoted above the dialog still isn't hit-testable —
   `elementFromPoint` falls through to the dialog. The only place both
   above the modal *and* clickable is inside the dialog's subtree. The
   picker therefore **re-homes its UI into the topmost open modal dialog**
   (plain fixed elements — the dialog already paints in the top layer) and
   returns to `<body>`-with-popovers when it closes. A MutationObserver on
   dialogs' `open` attribute drives this with no user action.
   **The trade-off, stated honestly:** while a modal is open the picker's
   own UI lives in the page's light DOM, so page script can read it and
   click it — the extension's closed shadow root buys no isolation in that
   window. Working *is* the requirement here, so the mitigation is
   narrower: the two decisions that must be a human's — a review verdict
   and committing a note — require `isTrusted`, which script cannot forge.
   Everything else the page could drive (opening the popover, moving the
   highlight) costs nothing.
3. **Capture at the window, not the document.** Pages register their own
   capture-phase handlers (e.g. a modal opener on `document`); whoever is
   closer to the root wins. Picker listeners go on `window` with capture.
4. **Suppress the whole pointer sequence while picking.** Canceling only
   `click` still lets `pointerdown`/`mousedown` handlers fire (menus open,
   buttons act). Cancel `pointerdown/up`, `mousedown/up` for non-picker
   targets; the derived `click` still arrives for selection.
5. **Selector quality is the product.** Prefer stable ids/attrs, fall back
   to `:nth-of-type` paths; always pair the CSS selector with the detected
   component name and trimmed element text so the agent can survive a
   selector gone stale.

## Security

The bridge is a loopback HTTP daemon with permissive CORS, and that is not
an oversight: the embed runs on whatever origin the developer's app uses,
and the extension injects into arbitrary sites, so there is no origin
allowlist to write. The consequence has to be said out loud — **while the
daemon runs, every page the developer visits can reach it**, and can write
to and read from a project's `.fix-ui.jsonl`. Full model and operator
advice: agent-integration.md "Privacy and trust". In this repo's terms:

- **Loopback `Host` only** (403 otherwise). This is the DNS-rebinding
  defence; CORS cannot be one.
- **Caps at the boundary**: 256KB bodies (413), `note` ≤ 10000 and
  `selector` ≤ 2000 characters (400) — the same numbers core enforces
  before it will queue an entry, so the two never disagree.
- **The review channel is token-gated.** `GET /events` and
  `POST /reviews/:id/verdict` need the daemon's token (`?token=` or
  `x-fixui-token`); 401 without it. Subscribing is how a page would learn a
  `reviewId`, and a `reviewId` is enough to approve a review the human has
  not seen — the token is what makes "human-in-the-loop" true rather than
  aspirational. Generated per run (or `FIXUI_TOKEN`), printed on stderr,
  written to `.fix-ui.token` in the daemon's cwd (gitignored) so local
  adapters can pick it up out of band. `POST /reviews` stays open, because
  a proxy instance in another project's cwd cannot read that file.
- **Entries are untrusted input.** They are what somebody typed in a
  browser, and the entries routes are open, so an agent must treat them as
  a description of a UI complaint — never as instructions.
- **The extension keeps its own queue.** A content script shares the
  page's origin storage, so core's durable queue is handed
  `chrome.storage.local` instead: otherwise a page could seed entries and
  have the extension post them on the next toolbar click. The configured
  project also overrides any `project` an entry carries — the destination
  directory is the adapter's decision, not the data's.

## Error handling

- Bridge unreachable → the adapter queues locally (memory + `localStorage`,
  or `chrome.storage` in the extension) and retries with backoff; last
  resort copies the entry JSON to the clipboard (prototype behavior, kept).
- Inbox file unwritable → bridge answers 500 with the path it tried; the
  adapter surfaces the toast verbatim — no silent drops. "Bridge
  unreachable" is reserved for a request that got no answer at all.
- `request_review` with no adapter connected → immediate
  `{ verdict: "no-reviewer" }` so the agent isn't stuck.
- Malformed entries → rejected at the schema boundary (core validates
  before POST; bridge re-validates).

## Testing

- Core: unit tests for selector building (the prototype's suite —
  `tools/ui-feedback/src/dom.test.ts` — moves here), picker state
  machine, ring buffer.
- Adapters: Playwright against fixture pages — including a modal-dialog
  fixture asserting the re-homing behavior (pick inside an open modal;
  assert the page's button did NOT activate).
- Bridge: HTTP + MCP contract tests; a fake adapter for review-flow tests
  (request → notes → verdict round-trip, and the timeout path).

## Monorepo shape

```
fix-ui/
├── packages/
│   └── fixui/          # the one published package
│       ├── src/core/   #   picker engine
│       ├── src/embed/  #   npm adapters  → dist/embed, dist/fixui.global.js
│       ├── src/bridge/ #   daemon + MCP  → dist/bridge/cli.js (the `fixui` bin)
│       └── skills/fix-ui/
├── extension/          # MV3, private; bundles src/core from source
├── e2e/                # Playwright: real Chromium, real bridge daemon; private
└── docs/
```

pnpm workspace, mirroring hulbu's conventions. One publishable package by
design: three of them meant three version pins between things that ship
separately, and the first publish died on exactly that.

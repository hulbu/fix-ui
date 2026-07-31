# fix-ui — design

2026-07-31 · status: approved design, not yet built. Extracted from the
working prototype in `hulbu/tools/ui-feedback`.

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

### `@hulbu/fixui-core`

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

### `@hulbu/fixui` — the npm embed

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

### `fixui-bridge`

What it does: single local daemon.
- HTTP: `POST /entries` (create), `GET /entries` (list), `DELETE
  /entries/:id` — same shape the prototype's Next.js route exposes today,
  so the embed can also run bridge-less against an app-provided endpoint.
- Storage: appends to `.fix-ui.jsonl` in the target project directory
  (per-project routing by a `project` field or the bridge's cwd).
- MCP server for agents: see agent-integration.md.
- Review broker: holds pending `request_review` calls open and pairs them
  with a connected adapter (SSE/WebSocket to the page) — the
  human-in-the-loop channel.

Depends on: node stdlib + an MCP SDK. No database; the JSONL file is the
queue and the audit log.

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

## Error handling

- Bridge unreachable → the adapter queues locally (memory + `localStorage`)
  and retries with backoff; last resort copies the entry JSON to the
  clipboard (prototype behavior, kept).
- Inbox file unwritable → bridge answers 500 with the path it tried; the
  adapter surfaces the toast verbatim — no silent drops.
- `request_review` with no adapter connected → immediate
  `{ verdict: "no-reviewer" }` so the agent isn't stuck.
- Malformed entries → rejected at the schema boundary (core validates
  before POST; bridge re-validates).

## Testing

- Core: unit tests for selector building (the prototype's suite moves
  here), picker state machine, ring buffer.
- Adapters: Playwright against fixture pages — including a modal-dialog
  fixture asserting the re-homing behavior (pick inside an open modal;
  assert the page's button did NOT activate).
- Bridge: HTTP + MCP contract tests; a fake adapter for review-flow tests
  (request → notes → verdict round-trip, and the timeout path).

## Monorepo shape (when building starts)

```
fix-ui/
├── packages/
│   ├── core/
│   ├── embed/
│   └── bridge/
├── extension/          # MV3, consumes core via the bundler
└── docs/
```

pnpm workspace, mirroring hulbu's conventions.

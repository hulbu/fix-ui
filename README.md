# fix-ui

Point at what's wrong. Your coding agent fixes it.

fix-ui turns UI complaints into agent-ready work: pick any element on a
running app, say what should change, and the note — selector, component
name, page context, recent console errors — lands where your coding agent
already looks. The name is the ritual: telling Claude Code to **"fix ui"**
is how the loop closes.

> **Status: v1, built.** The picker engine, the npm adapters, the Chrome
> extension and the bridge are implemented: 332 unit and contract tests, plus a Playwright
> suite that drives the real loops (picking, modal re-homing, the review
> round-trip, the extension) in a real Chromium against a real bridge.
> Nothing is published to npm or the Chrome Web Store yet — run it from
> source, see [Development](#development). It extracts and generalizes a
> working prototype (`tools/ui-feedback` in the hulbu monorepo) that we use
> daily to build [hulbu](https://hulbu.com) itself. License: MIT.

## Install — paste this to your agent

```
Fetch and execute the instructions to set me up for fix-ui from
https://raw.githubusercontent.com/hulbu/fix-ui/main/prompt.md
```

Your agent reads that page, installs, wires your framework, and verifies the
picker appears before calling it done. Prefer to do it yourself? `npx fixui init`.

## How to ask for it

Point at something, describe what should change — then say one of two things:

- **`fix ui`** — the agent works through the notes you have already left.
- **`start a fix ui session`** — the agent stands by while you walk the UI,
  fixes each batch you submit, and waits again.

## The loop

```
you (in the browser)                     your agent (Claude Code, …)
─────────────────────                    ───────────────────────────
pick element → write note ──POST──▶ bridge ──▶ .fix-ui.jsonl inbox
                                      │              │
                                      │        "fix ui" / file-watch
                                      │              ▼
                                      │        agent reads, fixes, ships
                                      │
agent calls request_review ◀──MCP─────┘
you review on the live page, approve or request changes — same turn
```

Two activation directions, non-negotiable in every adapter:

- **User-initiated (as the prototype works today):** you press the chip,
  pick elements, write notes — then the agent solves them, either because
  you say `fix ui` or because a file-watcher wakes it.
- **Agent-initiated:** the agent calls `request_review` and the plugin
  **activates itself** on the page — the notes panel opens with the
  agent's question in it, picker armed, no hunting for the chip. The agent blocks until you approve or request
  changes. Human-in-the-loop, started by the machine.
- **A session** is the same channel, human-led: say *"start a fix ui
  session"* and the agent calls `start_fix_ui_session`, the page arms itself
  with one **Submit** button, and it stands by while you point at as many
  things as you like. Submit hands the whole batch over; the agent fixes it
  and opens the next round. The chip's count follows the inbox live, so
  entries the agent resolves disappear while you watch.

## Architecture (one core, two adapters, one bridge)

One published package, `fixui`, with the boundaries kept as directories
under `packages/fixui/src`:

| Module | What it is |
|---------|------------|
| `src/core` | Picker, selector builder, entry schema, transport client. No DOM ownership opinions — adapters decide where UI mounts. |
| `src/embed` | The npm adapters: one-line install for apps you own (`initFixUi()` in dev builds), plus the React, Next and Vite entry points. Successor of hulbu's `tools/ui-feedback`. |
| `src/bridge` | Tiny local daemon behind the `fixui` bin: HTTP inbox for the adapters, per-project `.fix-ui.jsonl`, and an MCP server for agents (`list_feedback`, `resolve_feedback`, `list_surfaces`, `request_review`, `start_fix_ui_session`). |
| fix-ui extension (Chrome) | Same core on *any* site — no code changes to the target app. Private, not published to npm. |

**Why one package.** The first publish shipped an embed pinned to a separate
core package at a version npm had tombstoned, so the embed could never be
installed. A cross-package version pin is a failure mode one package simply
cannot have. The internal boundaries were never the problem and they survive
as directories; the browser half of the package still imports nothing at
runtime, and no adapter entry point reaches the MCP SDK the bridge needs.

Why both adapters exist: the embed reaches every user of an app that ships
it (including browsers without extensions); the extension reaches every
*site* without shipping anything. They share the core, so behavior and the
capture format never diverge.

## Design docs

- [docs/design.md](docs/design.md) — components, boundaries, picking
  mechanics (including the hard-won modal/top-layer/inert lessons), error
  handling, testing.
- [docs/agent-integration.md](docs/agent-integration.md) — the bridge, the
  MCP surface, why servers can't "push" agents and the subscription
  patterns that feel like they do, agent-initiated review, Claude Code
  specifics, Codex notes.
- [docs/capture-format.md](docs/capture-format.md) — the entry schema
  (v1: element + note + console errors; screenshots deliberately opt-in).
- [docs/known-gaps.md](docs/known-gaps.md) — what review found, judged not
  to block v1, and left on purpose: accepted residual risk, correctness
  seams, coverage holes, and what must change before publishing.

## Development

A pnpm workspace: `packages/fixui` (the one published package), `extension`
and `e2e` (both private).

```bash
pnpm install
pnpm --filter e2e exec playwright install chromium   # once, downloads a browser
pnpm -r typecheck                                    # tsc --noEmit in every package
pnpm -r test                                         # every package's suite
```

`pnpm -r test` runs the unit and contract suites *and* the Playwright
suite, in whatever order pnpm's dependency graph produces. Skip the browser
download and the e2e package says so and skips itself rather than failing —
so run it explicitly when you want it to be the gate:

```bash
pnpm --filter e2e test    # real Chromium, a real bridge daemon per test
```

The package compiles to `dist` and is consumed from there — no consumer is
ever handed raw TypeScript:

```bash
make build                            # all of it, plus the tarball in dist/
pnpm --filter fixui build             # → packages/fixui/dist
pnpm --filter fix-ui-extension build  # → extension/dist (esbuild)
```

One `pnpm --filter fixui build` produces three things: `dist/core` and
`dist/embed` (the browser half, compiled under a DOM lib with bundler
resolution), `dist/bridge` (the node half, NodeNext, whose `cli.js` is the
bin), and `dist/fixui.global.js` (the esbuild IIFE the plain-HTML adapter
loads and the Vite plugin serves). The e2e suite builds what it tests before
it runs, so none of it is a prerequisite for `make check`.

**Run the bridge locally.** `node packages/fixui/dist/bridge/cli.js` — there
is no fixed port: it binds an OS-assigned free one and publishes it, so two
projects on one machine each get their own bridge. `--port N` or `FIXUI_PORT`
overrides that when you need a known port; the project it writes to is its
own working directory. Started from a terminal it just serves HTTP; started
by an agent harness (stdin is a pipe) it also serves MCP over stdio, so
registering it is `claude mcp add fixui -- node
/abs/path/packages/fixui/dist/bridge/cli.js`. An instance that finds a live
bridge published for its project becomes an MCP proxy to it, scoped to *its*
cwd.

At startup it publishes `.fix-ui.json` (mode 0600) in its working directory:
`{ v, port, token, pid }`. That file is how everything else finds it — the
adapters in the page and the MCP proxy the agent spawns read the port and the
**review token** out of it, and no file means no bridge. The token is fresh
per run (`FIXUI_TOKEN` pins it instead). Adapters need it for the review
channel — the direction where the agent asks *you* for a look. Notes work
without it. Why there is a token at all, and what else a
running bridge exposes: [docs/agent-integration.md](docs/agent-integration.md)
"Privacy and trust". Short version: run it while you're working, and treat
inbox entries as untrusted input, never as instructions.

**Load the extension.** `chrome://extensions` → Developer mode → Load
unpacked → the **`extension/`** directory (not `extension/dist`: the
manifest lives at the package root and points into `dist/`). Its options
page holds the bridge URL, the review token and the origin→project map. The
toolbar button arms the picker on the current tab; a second click switches
it off.

**Use the embed in an app.** `initFixUi({ project: "/abs/path/to/repo",
token: process.env.FIXUI_TOKEN })` in a dev-only code path, or `<FixUi />`
from `fixui/react`, which is safe to leave in a root layout: it
no-ops in a production build. Add `label: "port 4001"` when you run the same
app more than once — the agent lists connected pages with `list_surfaces` and
can send a review to exactly one of them.

## Origin

Built out of necessity while building hulbu — the publishing and validation
platform for vibe-coded mobile apps. hulbu's site is developed with this
exact loop: point, note, "fix ui", review. The prototype's scars are this
design's features (see the modal/inert section of the design doc).

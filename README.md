# fix-ui

Point at what's wrong. Your coding agent fixes it.

fix-ui turns UI complaints into agent-ready work: pick any element on a
running app, say what should change, and the note — selector, component
name, page context, recent console errors — lands where your coding agent
already looks. The name is the ritual: telling Claude Code to **"fix ui"**
is how the loop closes.

> **Status: v1, built.** Core, the npm embed, the Chrome extension and the
> bridge are implemented: 199 unit and contract tests, plus a Playwright
> suite that drives the real loops (picking, modal re-homing, the review
> round-trip, the extension) in a real Chromium against a real bridge.
> Nothing is published to npm or the Chrome Web Store yet — run it from
> source, see [Development](#development). It extracts and generalizes a
> working prototype (`tools/ui-feedback` in the hulbu monorepo) that we use
> daily to build [hulbu](https://hulbu.com) itself. License: MIT.

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
  **activates itself** on the page — review banner up, picker armed, no
  hunting for the chip. The agent blocks until you approve or request
  changes. Human-in-the-loop, started by the machine.

## Architecture (one core, two adapters, one bridge)

| Package | What it is |
|---------|------------|
| `@hulbu/fixui-core` | Picker, selector builder, entry schema, transport client. No DOM ownership opinions — adapters decide where UI mounts. |
| `@hulbu/fixui` (npm embed) | One-line install for apps you own (`initFixUi()` in dev builds). Successor of hulbu's `tools/ui-feedback`. |
| fix-ui extension (Chrome) | Same core on *any* site — no code changes to the target app. |
| `fixui-bridge` | Tiny local daemon: HTTP inbox for the adapters, per-project `.fix-ui.jsonl`, and an MCP server for agents (`list_feedback`, `resolve_feedback`, `request_review`). |

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

A pnpm workspace: `packages/*` (core, embed, bridge), `extension`, `e2e`.

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

Two packages have a build; core and the embed ship TypeScript sources and
are bundled by whatever consumes them:

```bash
pnpm --filter fixui-bridge build      # → packages/bridge/dist (cli.js is the bin)
pnpm --filter fix-ui-extension build  # → extension/dist (esbuild)
```

The e2e suite builds what it tests before it runs, so neither is a
prerequisite for it.

**Run the bridge locally.** `node packages/bridge/dist/cli.js` — port 3499
by default, `--port N` or `FIXUI_PORT` to move it; the project it writes to
is its own working directory. Started from a terminal it just serves HTTP;
started by an agent harness (stdin is a pipe) it also serves MCP over
stdio, so registering it is `claude mcp add fixui -- node
/abs/path/packages/bridge/dist/cli.js`. A second instance finds the port
taken by a bridge and becomes an MCP proxy to it, scoped to *its* cwd.

At startup it prints a **review token** and writes it to `.fix-ui.token` in
its working directory (`FIXUI_TOKEN` pins it instead). Adapters need that
token for the review channel — the direction where the agent asks *you* for
a look. Notes work without it. Why there is a token at all, and what else a
running daemon exposes: [docs/agent-integration.md](docs/agent-integration.md)
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
from `@hulbu/fixui/react`, which is safe to leave in a root layout: it
no-ops in a production build.

## Origin

Built out of necessity while building hulbu — the publishing and validation
platform for vibe-coded mobile apps. hulbu's site is developed with this
exact loop: point, note, "fix ui", review. The prototype's scars are this
design's features (see the modal/inert section of the design doc).

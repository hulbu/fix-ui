# fix-ui

Point at what's wrong. Your coding agent fixes it.

fix-ui turns UI complaints into agent-ready work: pick any element on a
running app, say what should change, and the note — selector, component
name, page context, recent console errors — lands where your coding agent
already looks. The name is the ritual: telling Claude Code to **"fix ui"**
is how the loop closes.

> **Status: design phase.** This repo is documentation only — nothing is
> built yet. It extracts and generalizes a working prototype
> (`tools/ui-feedback` in the hulbu monorepo) that we use daily to build
> [hulbu](https://hulbu.com) itself. License: MIT intended at
> open-sourcing.

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

## Origin

Built out of necessity while building hulbu — the publishing and validation
platform for vibe-coded mobile apps. hulbu's site is developed with this
exact loop: point, note, "fix ui", review. The prototype's scars are this
design's features (see the modal/inert section of the design doc).

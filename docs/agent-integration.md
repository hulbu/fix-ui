# fix-ui — agent integration

How feedback reaches an agent, and how an agent brings a human into the
loop. Claude Code is the first-class target; the protocol is agent-neutral.

## The one fact everything follows from

**MCP servers cannot start a conversation with an agent.** Tools are
agent-initiated: the agent calls, the server answers. A browser plugin
(or any MCP server) has no channel to spontaneously make Claude Code start
working.

The "interactive options where the agent somehow knows what you picked"
experience is not a push either — it's a **blocking tool call**: the
harness's own question tool renders choices, the agent's turn is suspended
awaiting the tool result, and your click *is* the result. The agent never
learned anything unprompted; it was waiting on a call it made.

Both integration directions below are honest applications of that fact.

## Direction 1 — human → agent (the inbox)

```
picker → POST /entries → fixui-bridge → <project>/.fix-ui.jsonl
```

The inbox file is the contract. Any agent that can read a file can
participate; everything else is convenience:

- **The ritual:** you type `fix ui`; the agent reads the inbox, fixes
  entries, deletes them via the bridge (or truncates the file). This is
  the prototype's daily loop at hulbu.
- **The watcher (feels like push, is a subscription):** the agent-side
  harness watches the inbox and wakes the agent when entries land:
  - Claude Code **hooks** — a hook watching the file can inject "new
    fix-ui entries arrived" context into the session.
  - A **Monitor / background watcher** started by the agent ("watch
    .fix-ui.jsonl and handle new entries") — the harness re-invokes the
    agent when it fires.
  - A **`/loop`** or scheduled check — poll-based, coarser, works
    everywhere.
- **MCP tools** (nicety over the same data): `list_feedback()`,
  `resolve_feedback(id)` — structured access without paths, plus
  `feedback/updated` notifications for clients that surface them. The
  notification does not start a turn (see the one fact); it only helps
  harnesses that choose to react.

## Direction 2 — agent → human (`request_review`)

The inverse loop, and the reason the bridge exists as a daemon rather than
a dumb file writer. After changing UI, the agent asks for eyes:

```
agent                bridge                    page (embed/extension)
  │ request_review ──▶ hold the call open
  │                    └─▶ SSE: "review requested: hero section"
  │                                   │  the plugin ACTIVATES ITSELF:
  │                                   │  review banner + armed picker —
  │                                   │  the human never hunts for the
  │                                   │  chip. They click around, drop
  │                                   │  notes, press Approve /
  │                                   │  Request changes
  │                    ◀── verdict + entries
  │ ◀── tool result: { verdict, entries[], durationMs }
  ▼
agent continues the SAME turn with the verdict in hand
```

Agent-side activation is a hard requirement, symmetric with the
user-initiated mode: the user's flow starts at the chip; the agent's flow
starts at the tool call, and the page UI wakes up on its own.

Tool shape:

```
request_review({
  prompt:  "Review the new pricing table",
  url?:    "http://localhost:4001/#pricing",   // adapter navigates/anchors
  timeoutSeconds?: 600,
})
→ { verdict: "approved" | "changes" | "timeout" | "no-reviewer",
    entries: FeedbackEntry[],   // notes left during the review
    durationMs: number }
```

Engineering notes:

- **Keep-alives:** long waits must not trip client tool timeouts. The
  bridge emits MCP progress notifications ("waiting for reviewer, 45s…")
  for the pending call; clients that honor progress keep the call alive.
  Timeout is still a first-class verdict, not an error.
- **No reviewer connected** → return `no-reviewer` immediately. The agent
  falls back to a terminal question instead of hanging.
- **Verdict semantics:** `changes` + entries is the actionable pair — the
  agent treats the entries as the change request and continues working;
  `approved` closes the loop.
- **One review at a time** per project in v1. A second `request_review`
  while one is pending fails fast with a `busy` tool error — not a verdict
  (scope discipline; queues are v2).

## Claude Code specifics

- Bridge registers as a local MCP server (`claude mcp add fixui -- npx
  fixui-bridge`), exposing: `list_feedback`, `resolve_feedback`,
  `request_review`.
- The inbox path follows the project: bridge resolves the target project
  from the adapter's `project` field (the embed defaults it to its own
  origin's configured project; the extension's options page maps origins
  to project directories).
- Suggested CLAUDE.md line for consuming projects: `"fix ui" → read
  .fix-ui.jsonl (or fixui list_feedback) and fix entries; after UI work,
  call request_review before claiming done.`

## Codex and other agents

- Codex ships its own browser/harness; the file inbox works as-is (read
  `.fix-ui.jsonl`), and MCP support keeps the tool surface available where
  Codex supports MCP servers. `request_review`'s blocking pattern is
  standard MCP — nothing Claude-specific — but each harness's tool-timeout
  behavior must be verified before advertising support.
- Agents with neither MCP nor file access are out of scope; the JSONL file
  is deliberately the lowest common denominator.

## Privacy

Everything is localhost by default: adapter → bridge → project file. No
cloud component exists in v1; nothing leaves the machine unless the user
points the endpoint elsewhere. Entries contain page-visible text only —
never form values, cookies, or storage.

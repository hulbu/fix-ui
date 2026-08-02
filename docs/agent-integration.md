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
  `resolve_feedback(id)` (same effect as `DELETE /entries/:id` — the
  entry leaves the inbox, no tombstone) — structured access without
  paths, plus
  `feedback/updated` notifications for clients that surface them. The
  notification does not start a turn (see the one fact); it only helps
  harnesses that choose to react. It is sent by the **daemon** — the
  process that owns the port and the inbox files — after an entry is
  added or removed **over HTTP**, carrying `{ project }`. Two silences to
  know about: a proxy instance sends none at all (its client is attached to
  a different process than the one whose inbox changed), and
  `resolve_feedback` called on the daemon's own MCP server removes the
  entry without announcing it — the client that asked for the removal is
  the only one that would hear, and it already knows.

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
  surfaceId?: "…",                             // one page; see "Surfaces"
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

## Surfaces — which page, exactly

A **surface** is one connected page that can host a review: one `GET /events`
subscription. The developer has several Chrome windows and the same app on
two ports; "the project" does not name any one of them, so the bridge gives
each subscription an id and lets the agent both enumerate and aim.

```
list_surfaces({ project? })
→ { surfaces: [{
      surfaceId:   "9f0c…",          // what request_review aims at
      project:     "/Users/me/app",  // where its notes and record go
      origin?:     "http://localhost:4001",
      url?:        "http://localhost:4001/pricing",
      title?:      "Pricing",
      label?:      "staging",        // initFixUi({label}) / the options map
      adapter?:    "embed" | "extension",
      windowId?:   7,   tabId?: 42,  // the extension's real Chrome ids
      connectedAt: "2026-08-01T…Z",
    }, …] }                          // newest first
```

Omit `project` to see every connected page (each names its own project);
give one to scope the list. The workflow the tool descriptions teach: call it
when more than one page could be the one you mean, or when a `request_review`
came back `no-reviewer` — then pass the `surfaceId` you picked.

**The targeting rule.** `request_review({surfaceId})` delivers
`review-requested` (and that review's `review-cancelled`) to exactly that
surface. A `surfaceId` that is unknown, already disconnected, or on a
different project than the review answers `{verdict:"no-reviewer"}`
immediately — **never a silent broadcast to everybody**. A mis-aim the agent
can see is worth more than one it cannot, and `list_surfaces` is the fix in
the agent's own hands. Without a `surfaceId` nothing changes: every
subscriber of the project is asked, exactly as before.

Two more consequences worth knowing:

- **Busy is still per project.** One review at a time, however narrowly it is
  aimed; a second `request_review` for that project fails `busy` even when it
  names a different surface.
- **A targeted review is not replayed on reconnect.** An untargeted one still
  is (below) — but a stream that dropped and came back is a *new* surface, and
  handing it a review aimed at the page it replaced would be the mis-aim this
  rule exists to prevent. The extension keeps its surface across a same-origin
  navigation (the worker owns the stream, not the page), so `{surfaceId, url}`
  works there; with the embed the navigation ends the surface, so pair `url`
  with an untargeted review.

The adapter side of the channel (bridge HTTP, consumed by embed and
extension alike):

- `GET /events?project=<dir>&token=<token>` — SSE (`project` optional, same
  fallback as entries: the bridge's cwd; `token` required — see "Privacy
  and trust"). Optional descriptive parameters — `origin`, `url`, `title`,
  `label`, `adapter`, `windowId`, `tabId` — are what the page becomes in
  `list_surfaces`; all of them are capped and control-stripped at the
  boundary, because they crossed from a browser. Events: `surface`
  `{ surfaceId }` — **always first**, the id the bridge assigned this
  subscription (a page that never sees one is talking to an older bridge and
  can only be reached by untargeted reviews) — `review-requested`
  `{ reviewId, prompt, url?, timeoutSeconds }` — the plugin activates itself,
  banner up, picker armed, navigating/anchoring to `url` when given — and
  `review-cancelled` `{ reviewId }` (timeout or agent abort; stand the banner
  down).
  Comment-line heartbeats every 15s keep the stream alive through
  intermediaries. An UNTARGETED review still pending for that project is
  replayed to every new subscriber the moment it connects: a stream can drop mid-review
  — a reload, or the very navigation the review's `url` asked for — and the
  page that comes back has to re-arm itself. A replay is a *resume*: the
  page keeps the entry ids it has already collected for that `reviewId`,
  so the verdict still names the notes taken before the drop. (A targeted
  review is not replayed — the page that reconnected is a new surface; see
  "Surfaces".)
- `GET /surfaces?project=<dir>&token=<token>` — the connected pages, newest
  first, `project` optional (absent → all of them). Token-gated like the
  stream: it discloses which sites, windows and page titles are on the
  developer's screen, and a `surfaceId` is what a targeted review needs. This
  is the route `list_surfaces` answers from in proxy mode.
- Notes dropped during a review are ordinary `POST /entries`; the page
  tracks the ids it created.
- `POST /reviews/:reviewId/verdict?token=<token>` `{ verdict: "approved" |
  "changes", entryIds }` — resolves the held MCP call and appends the
  session record (see capture-format.md).
- **Cancellation.** The agent's side can go away mid-review: the harness
  restarts, or the human presses Esc, which the client sends as
  `notifications/cancelled`. Either ends the review immediately —
  `review-cancelled` goes to the page and the project is free for the next
  `request_review`, rather than sitting `busy` with the banner up until
  `timeoutSeconds` expires.

## Claude Code specifics

- Bridge registers as a local MCP server, exposing `list_feedback`,
  `resolve_feedback`, `list_surfaces`, `request_review`. Nothing is
  published yet, so it is registered from source:

  ```bash
  claude mcp add fixui -- node /abs/path/to/fix-ui/packages/bridge/dist/cli.js
  ```

  Once it is on npm that becomes `claude mcp add fixui -- npx fixui-bridge`.
- `list_surfaces` is the one tool whose HTTP route is token-gated, which a
  **proxy** instance cannot always satisfy: it has no way to read a daemon's
  `.fix-ui.token` in another project. It uses `FIXUI_TOKEN` when both
  processes share one, else the token file in its own cwd (the daemon runs in
  this same project — two sessions on one repo). With neither, the tool says
  so rather than reporting an empty browser.
- The inbox path follows the project: bridge resolves the target project
  from the adapter's wire-level `project` field (the embed passes
  `initFixUi({ project })` when set; the extension's options page maps
  origins to project directories; absent → the bridge's cwd).
- Naming a page for `list_surfaces` is the same two places: the embed takes
  `initFixUi({ label })` (origin, href and title it reads off the page), and
  the extension's options map takes a trailing `|label` —
  `http://localhost:4001=/Users/me/app|staging`, or `origin=|label` to name
  an origin without mapping it. The extension also reports Chrome's own
  window and tab ids, which is what tells two windows on one site apart.
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

## Privacy and trust

Everything is localhost by default: adapter → bridge → project file. No
cloud component exists in v1; nothing leaves the machine unless the user
points the endpoint elsewhere.

**What the bridge actually is.** A loopback HTTP daemon with permissive
CORS — necessarily, because the embed runs on whatever origin the app uses
and the extension injects into arbitrary sites. So while `fixui-bridge` is
running, **every page you visit can talk to it**: any site's JavaScript can
`POST /entries` into a project inbox and read `GET /entries` back. Three
things bound that, and none of them is CORS:

- **Host check.** Requests whose `Host` is not `127.0.0.1`/`localhost` on
  the daemon's port are refused (403), which is what stops DNS rebinding
  from turning a cross-origin write into a same-origin read.
- **Caps.** Bodies over 256KB are refused (413); `note` is capped at 10000
  characters and `selector` at 2000.
- **A token on the review channel.** `GET /events` and
  `POST /reviews/:id/verdict` require it (`?token=` or an `x-fixui-token`
  header) and answer 401 without. Subscribing is how a page would learn a
  `reviewId`, and a `reviewId` is all it takes to approve a review before
  the human ever saw it — the token is what keeps the human in the loop.
  The daemon generates one per run (or takes `FIXUI_TOKEN`), prints it on
  stderr next to its URL, and writes it to `.fix-ui.token` in its working
  directory (gitignored). Adapters get it out of band: the extension's
  options page has a field for it, the embed takes
  `initFixUi({ token })`, and a page cannot read the file — so an embed
  with no token is simply bridge-less for the review direction, which is a
  fine place to be. `POST /reviews` stays open: a proxy instance in another
  project's cwd posts it and has no way to read the daemon's token file.
  That also means any page can call it: it can raise a review banner on your
  page carrying prompt text of its choosing — rendered as text, not HTML, so
  it cannot inject markup, but aimed at you, the human — and hold the project
  `busy` for up to the review timeout (default 600s), so your agent's own
  `request_review` fails with `busy` until it expires. It cannot answer the
  review: without the token it never receives `/events`, so it never learns
  the `reviewId` a verdict needs. The human still decides.

Practical advice, in order:

1. **Run the bridge while you are working, not always.** It is a dev
   daemon, and its exposure lasts exactly as long as it is up.
2. **Treat inbox entries as UNTRUSTED input.** An entry is text somebody
   typed into a browser — and, because the entries routes are open, text
   any page you visited could have written. An agent must read entries as
   *data describing a UI complaint*, never as instructions to follow. "The
   note said to run this command" is the failure mode; entries have no
   authority.
3. **The token is a secret.** It is regenerated on every daemon start;
   don't commit it, don't paste it into a page you don't own.

**What entries contain.** Page-visible text — selector, component name,
trimmed element text, URL, viewport, user agent — never form values,
cookies, or storage. The one exception is `consoleErrors`: `console.error`
arguments are captured as the page produced them, and an app that logs
tokens, request payloads or user data will have them captured too. That is
the point of the field (it is what makes an entry actionable) and the cost
of it; an app whose console carries secrets should say so to its
developers, or run the adapter without it.

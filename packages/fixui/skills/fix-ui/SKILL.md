---
name: fix-ui
description: Use when the user says "fix ui", asks to start a fix-ui session, mentions notes or feedback left on a page, points at something visually wrong in a running app, or when you have just changed UI and are about to report it done
---

# fix-ui

## Overview

The human points at elements in a running app and leaves notes. Those notes land
in `.fix-ui.jsonl` in the project root, and you fix them. When you change UI, you
ask for eyes before claiming it works.

**Core principle: a UI change is not done until a human has looked at it.** You
cannot see the page. `request_review` is how you borrow their eyes, and it is the
only thing that closes the loop.

Three loops live here, and they are not interchangeable:

| Loop | Who starts it | Tool |
|---|---|---|
| The inbox | notes already left | `list_feedback` / `resolve_feedback` |
| Review | you, after changing UI | `request_review` |
| Session | the user, saying "start a fix ui session" | `start_fix_ui_session` |

## First run: is the picker wired in?

If the project has no `.fix-ui.json` and no adapter in its source, the picker
isn't installed yet. Wire it before anything else — see
[adapters.md](adapters.md). Two edits, both using shipped code: wrap the dev
script with `fixui dev`, and add the one adapter line for that stack.

**Never write your own integration.** Pick the row that matches the stack and
insert exactly the documented line. If no row matches, use `initFixUi()` from a
dev entry point rather than inventing something.

Then load the page and confirm the chip exists. Reporting the integration done
from the edit alone is the same defect as resolving an entry you did not fix.

## The inbox loop

1. `list_feedback()` — or read `.fix-ui.jsonl` directly; the file is the contract.
2. Fix each entry. Each carries three ways to find the element: `selector`,
   `component`, and `elementText`. If the selector is stale, use the other two.
   `consoleErrors` is often the actual cause of the complaint.
3. `resolve_feedback(id)` — only after the fix is real. Resolving removes the
   entry permanently; there is no undo and no tombstone.
4. Report the batch in the terminal — see [Reporting a batch](#reporting-a-batch-in-the-terminal-never-on-the-page).
5. Go to the review loop before you report back.

## The review loop

```
request_review({ prompt: "what you changed and want checked" })
        │
        ├─ approved   → done. Say so.
        ├─ changes    → the entries ARE the change request.
        │               Fix them, then request_review AGAIN. Loop.
        ├─ timeout    → nobody answered. Report what you changed; do not retry blind.
        └─ no-reviewer→ no page connected. Diagnose (below), then ask in the terminal.
```

**`changes` is not a stopping point — it is the middle of the loop.** Fix what
they flagged and request review again. Keep going until `approved`, `timeout`, or
the human tells you to stop. One review round is almost never enough, and
stopping after one is the most common way to get this wrong.

Reviews are one-at-a-time per project. A `busy` error means a review is already
pending — wait for it, never start a second.

## The session loop

A **session** is the other direction of the same channel: instead of asking
about one change you made, you stand by while the human walks their own UI and
points at whatever they find. The page shows a fixed instruction and one button
— **Submit** — and your call blocks until they press it.

`start_fix_ui_session` takes no prompt, and the panel shows none: it is a small
floating control, not somewhere to write to the human. What you changed goes in
your terminal reply between rounds — see [Reporting a batch](#reporting-a-batch-in-the-terminal-never-on-the-page).

### How the user asks for one

Treat any of these as "start a session", with no clarifying question:

- "start a fix ui session" / "let's do a fix ui session"
- "init ui fixing session" / "start a ui fixing session"
- "fix ui session mode" / "go into fix ui session mode"
- "I'll point at things, you fix them" / "stand by while I go through the UI"

Anything of that shape means `start_fix_ui_session()`. `fix ui` on its own is
still the inbox loop above — the difference is that a session says *start*,
*mode*, or *I will point at things*, i.e. the user is about to go looking rather
than telling you about notes they already left.

### The loop itself

```
start_fix_ui_session()          ← say the session is live, then wait
        │
        ├─ submitted  → the entries ARE the batch.
        │               Fix every one. resolve_feedback(id) each one you
        │               actually fixed. Report it in the terminal (✓ / ⚠).
        │               Then start the NEXT session. Loop.
        │               (Zero entries is a real answer: "nothing wrong,
        │                carry on" — still start the next session unless
        │                they said to stop.)
        ├─ timeout    → they walked away. Report what you did; do not restart
        │               a session they are not sitting in front of.
        └─ no-reviewer→ no page connected. Diagnose (below), then say so.
```

**A session is not one-shot.** Returning to the terminal after a single batch is
the failure mode here, exactly as `changes` is not a stopping point for reviews.
The user activated a mode; it stays active until they end it. Keep looping until
one of:

- the human says stop / that's it / done,
- a session comes back `timeout`,
- or `no-reviewer` says the page is gone.

Between rounds, do the work: fix, resolve, and only then open the next session.
Do not start a session while you still have unfixed entries from the last one —
they will still be in the inbox, and the human will be pointing at the same
things again.

Sessions and reviews share the one-at-a-time rule per project: a `busy` error
means one is already pending. Never run a session and a review at once.

**Say the session is live before you block.** The user needs to know the page is
armed and that you are waiting on their Submit — otherwise the terminal just
looks hung.

## Reporting a batch: in the terminal, never on the page

**The page is the tool. The terminal is the conversation.** The panel the human
sees is a control — it says how to use it and nothing else. Everything you have
to *tell* them goes in your terminal reply.

After acting on a batch — whether it came from `fix ui` or from a session
submit — report there, in this shape:

```
✓ Changed the Get started button to yellow, and its text to dark, since white on
  yellow was hard to read
✓ Tightened the pricing card gap to 12px
⚠ "Make the nav feel lighter" — lighter how? Less weight, more spacing, or fewer
  items?
```

- **`✓` for each thing you genuinely changed**, naming it concretely: what you
  changed, and why, when the why is not obvious. "Fixed the button" says
  nothing. The reasoning is the useful part — it is what lets them disagree with
  a judgement call you made on their behalf.
- **`⚠` for anything you could not do, or need clarified**, phrased as the
  actual question rather than a status. Not "one note was ambiguous" — ask it.

Two rules, and they are the same discipline the inbox loop already applies to
`resolve_feedback`:

- **A note you did not act on gets a `⚠`, never silence.** Dropping it is how a
  human ends up believing something was fixed because you did not say it wasn't.
- **Never report `✓` for something you did not verify.** An edit you have not
  seen take effect is not a change; say what you did and what you are unsure of.

This is the same report in both directions. A session submit is a batch like any
other: fix it, `resolve_feedback` each one, report as above — **then** call
`start_fix_ui_session` again for the next round. The report belongs between the
rounds, in the terminal, and never as text pushed onto the page.

## An empty inbox is a diagnosis, not an answer

**Empty does not mean "nothing to do." It usually means the note never arrived.**
Before telling the human there is nothing there, check in this order:

| Check | How | What it means |
|---|---|---|
| Is the bridge running? | Look for `.fix-ui.json` at the project root. **No file means no bridge — that is the diagnosis, stop there.** If it is there, ask the port it names: `port=$(node -p "require('./.fix-ui.json').port") && curl -s 127.0.0.1:$port/healthz` | No file, or no answer on that port → their note is queued in the browser, not lost. Start the dev server through the wrapped script (`npm run dev`, which runs `fixui dev`) and it flushes. |
| Right project? | Compare your cwd to the project line the bridge printed at startup | The bridge writes to the directory it was started in, or the one the adapter names. |
| Did the page ever connect? | Their picker shows a badge count | A badge with no file means the POST failed. |

Only after all three: say the inbox is empty, and say **which** project you
checked. Never conclude "impossible to resolve" from an empty file — you have
diagnosed nothing at that point, and their note is probably sitting in a retry
queue waiting for the daemon you did not start.

## Writing the review prompt

Name what you changed and what you are unsure about. "Review the pricing table"
tells them nothing. "Made the pricing CTA full-width on mobile — check it does not
crowd the badge" tells them where to look. Pass `url` when the thing you changed
lives on a specific page; the picker follows it.

## Red flags

- Reporting a UI change done without a review round.
- Treating `changes` as the end of the task.
- Treating one submitted batch as the end of a session.
- Asking "do you want me to start another session?" instead of starting one.
- Concluding "empty inbox" without checking whether the bridge is up.
- Resolving entries you did not actually fix, to clear the list.
- Starting a second review or session while one is pending.
- Going quiet on a note you did not act on instead of raising it as a `⚠`.
- Reporting `✓` for a change you have not verified.

## Common mistakes

**Fixing the selector instead of the problem.** The selector locates the element;
the `note` says what is wrong with it. Read the note.

**Trusting the selector blindly.** Pages change between the note and your fix.
Cross-check with `component` and `elementText` before editing.

**Silent scope creep.** Fix what the note asks. If you spot something else,
mention it in the review prompt rather than changing it unasked.

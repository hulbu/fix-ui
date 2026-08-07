# fixui

Point at any UI element in your running app and leave a note for your coding
agent.

## Install — paste this to your agent

```
Fetch and execute the instructions to set me up for fix-ui from
https://raw.githubusercontent.com/hulbu/fix-ui/main/prompt.md
```

That is the whole install. Your agent reads the page, runs the installer, wires
the adapter for whatever framework this is, and confirms the picker actually
appears before telling you it is done.

Then: click the orange circle, point at something, describe what should change,
and say **`fix ui`**.

---

One package, two halves. The **adapter layer** is the one line you add to a
Next, Vite or plain-HTML app to put the picker on the page. The **bridge** is
the `fixui` bin: a local daemon that receives the notes into
`.fix-ui.jsonl`, and an MCP server so an agent can read them, resolve them and
ask you to review its own work.

## Install by hand

If you would rather not hand it to an agent, the installer does the same work:

```sh
npx fixui init
```

In a workspace it finds the package that renders the app and wires *that* one,
while the dev script it wraps is the root's — one bridge covers the repo. It
never prompts, and anything it could not finish it prints as a paste-ready
prompt for your agent, naming the package and the file.

## Adapters

| Stack | The line |
| --- | --- |
| Next (app router) | `import { FixUiScript } from "fixui/next"` — render `<FixUiScript />` last inside `<body>` in `app/layout.tsx` |
| Next (pages router) | `import { FixUi } from "fixui/react"` — render `<FixUi />` beside `<Component …>` in `pages/_app.tsx` |
| Vite | `import { fixui } from "fixui/vite"` — add `fixui()` to `plugins` |
| React, no framework | `import { FixUi } from "fixui/react"` — render `<FixUi />` once |
| plain HTML | `<script src="…/fixui/dist/fixui.global.js" data-port … data-token …>` |
| anything else | `import { initFixUi } from "fixui"` from a dev-only entry point |

`fixui/next` and `fixui/vite` run in **Node** — they read the running daemon's
port and token from a `0600` file on disk. `fixui`, `fixui/react` and the global
script run in the **browser**.

The picker only mounts in development: every adapter is gated on
`process.env.NODE_ENV`, and the Vite plugin is `apply: "serve"`, so a production
build cannot carry it or a token.

## The bridge

```sh
fixui dev -- <your dev command>   # the daemon, living exactly as long as your dev server
fixui init                        # wire a project up, once
fixui                             # spawned by an agent harness: MCP over stdio
```

## What it needs

The browser half needs nothing at runtime — no adapter entry point reaches the
package's one dependency (`@modelcontextprotocol/sdk`, which only the MCP server
imports). React is an optional peer, needed only for the `./react` and `./next`
entry points.

Docs and source: <https://github.com/hulbu/fix-ui>

MIT

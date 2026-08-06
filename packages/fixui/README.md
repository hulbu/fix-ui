# fixui

Point at any UI element in your running app and leave a note for your coding
agent.

One package, two halves. The **adapter layer** is the one line you add to a
Next, Vite or plain-HTML app to put the picker on the page. The **bridge** is
the `fixui` bin: a local daemon that receives the notes into
`.fix-ui.jsonl`, and an MCP server so an agent can read them, resolve them and
ask you to review its own work.

You almost certainly do not want to install this by hand. Run the installer
instead — it adds the dependency, wires the adapter, wraps your dev script,
registers the MCP server and drops the agent skill into the project:

```sh
npx fixui init
```

## Adapters

| Stack | The line |
| --- | --- |
| Next (app router) | `import { FixUiScript } from "fixui/next"` — render `<FixUiScript />` last inside `<body>` in `app/layout.tsx` |
| Next (pages router) | the same component, rendered in `pages/_app.tsx` |
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

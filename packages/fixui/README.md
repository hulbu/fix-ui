# @hulbu/fixui

Point at any UI element in your running app and leave a note for your coding
agent. This package is the **adapter layer**: the one line you add to a Next,
Vite or plain-HTML app to put the picker on the page.

You almost certainly do not want to install this by hand. Run the installer
instead — it adds the dependency, wires the adapter, wraps your dev script and
drops the agent skill into the project:

```sh
npx fixui-bridge init
```

## Adapters

| Stack | The line |
| --- | --- |
| Next (app router) | `import { FixUiScript } from "@hulbu/fixui/next"` — render `<FixUiScript />` last inside `<body>` in `app/layout.tsx` |
| Next (pages router) | the same component, rendered in `pages/_app.tsx` |
| Vite | `import { fixui } from "@hulbu/fixui/vite"` — add `fixui()` to `plugins` |
| React, no framework | `import { FixUi } from "@hulbu/fixui/react"` — render `<FixUi />` once |
| plain HTML | `<script src="…/@hulbu/fixui/dist/fixui.global.js" data-port … data-token …>` |
| anything else | `import { initFixUi } from "@hulbu/fixui"` from a dev-only entry point |

`@hulbu/fixui/next` and `@hulbu/fixui/vite` run in **Node** — they read the
running daemon's port and token from a `0600` file on disk. `@hulbu/fixui`,
`@hulbu/fixui/react` and the global script run in the **browser**.

The picker only mounts in development: every adapter is gated on
`process.env.NODE_ENV`, and the Vite plugin is `apply: "serve"`, so a production
build cannot carry it or a token.

## What it needs

Nothing at runtime. React is an optional peer, needed only for the `./react` and
`./next` entry points.

Pair it with [`fixui-bridge`](https://www.npmjs.com/package/fixui-bridge), the
local daemon that receives the notes.

Docs and source: <https://github.com/hulbu/fix-ui>

MIT

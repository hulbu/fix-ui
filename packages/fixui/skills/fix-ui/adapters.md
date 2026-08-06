# Wiring fix-ui into an app

Two edits. Both use code we ship — **never write your own integration.**

## Edit 1 — the bridge's lifetime (every stack)

In `package.json`, wrap the dev script:

```json
"dev": "fixui dev -- next dev"
```

`fixui dev` starts the bridge on a free port, writes `.fix-ui.json` (port + token), runs your dev command, and stops the bridge when it exits. Without this there is no bridge, and notes queue in the browser instead of reaching the inbox.

Already wrapped? Leave it.

## Edit 2 — put the picker on the page

Pick the row that matches. Insert exactly the line shown.

### Next, app router

In `app/layout.tsx` (or `src/app/layout.tsx`), inside `<body>`:

```tsx
import { FixUiScript } from "fixui/next";
// …
<body>
  {children}
  <FixUiScript />
</body>
```

**Also required** — `next.config.*`, or the import fails inside `node_modules`:

```ts
transpilePackages: ["fixui"]
```

`FixUiScript` is a server component: it reads `.fix-ui.json` and hands the port and token to the browser, so nothing is configured by hand. It returns `null` in a production build.

### Next, pages router

In `pages/_app.tsx`:

```tsx
import { FixUi } from "fixui/react";
// inside the returned tree:
<FixUi />
```

Same `transpilePackages` requirement. This variant can't read the discovery file (it's a client component), so pass the bridge explicitly if the defaults don't find it.

### Vite, Astro, SvelteKit

In `vite.config.*`:

```ts
import { fixui } from "fixui/vite";
export default defineConfig({ plugins: [fixui()] });
```

Serve-only — it adds nothing to a production build.

### Plain HTML, no bundler

```html
<script src="node_modules/fixui/dist/fixui.global.js"
        data-port="3499" data-token="…"></script>
```

Read the port and token out of `.fix-ui.json` and inline them. This is the one case with no automatic discovery, because nothing on the server side is rendering the page.

### Anything else

Call `initFixUi()` from a dev-only entry point:

```ts
if (import.meta.env?.DEV) {
  const { initFixUi } = await import("fixui");
  initFixUi({ label: "my app" });
}
```

## Then verify — this step is not optional

Editing the files is not evidence. Load the page and confirm the picker is actually there:

```
the chip is visible bottom-right, and `document.querySelector("[data-uifb-chip]")` is not null
```

If the chip is missing, work through these in order:

| Symptom | Cause |
|---|---|
| No chip at all | The adapter line isn't rendering — wrong file, or outside `<body>` |
| Module not found under `node_modules` | `transpilePackages` missing (Next) |
| `Module not found: fixui` | The dependency is in the wrong package.json (see *Monorepos*), or the bundler's compile root doesn't cover it — a `link:`/`file:` dependency resolving outside the project tree is refused by Turbopack and by Vite's `fs.allow`. Install a real copy (a packed tarball, or the published package) rather than widening the root |
| Chip present, notes never arrive | Dev server isn't running under `fixui dev` — no bridge, so notes queue |
| Chip present, badge counts up, inbox empty | Same as above; the notes are safe and flush when a bridge appears |

Report the integration done only after you have seen the chip.

## Monorepos

Three rules, and they are not the same rule.

**`fixui` goes in the package that renders the app** — `website/package.json`, not only the workspace root. With pnpm's isolated `node_modules`, a root-level install is simply not on that package's resolution path, and the import fails however correct the adapter line is. Keep it at the root as well, so the `fixui` bin the root dev script calls resolves there; `fixui init` installs it in both places.

**`fixui dev` wraps the ROOT dev script** — whatever command launches the whole stack (`turbo dev`, `pnpm -r dev`, a `run.sh`). One bridge then covers every app in the repo; wrapping each package's own dev script instead gives you several bridges racing for one inbox.

```json
// package.json at the repo root
"dev": "fixui dev -- turbo dev"
```

**The discovery file is written where `fixui dev` runs** — the repo root. The adapters walk up from the dev server's cwd to the repository root (the nearest `.git`) looking for `.fix-ui.json`, so an app in a subdirectory finds a bridge started above it. Nearest wins: a package running its own `fixui dev` keeps its own notes.

## Multiple apps at once

Give each one a label — `<FixUiScript label="admin" />`, `fixui({ label: "storefront" })`. The label appears in `list_surfaces`, so a review can be aimed at one specific page.

# fix-ui AI-first setup — Implementation Plan (revision B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** `npx fix-ui init` is the whole install. The bridge's lifetime belongs to the dev server, so a sink is running exactly when you could be leaving notes. The agent wires the app using **shipped adapters**, never hand-written integration code.

**Architecture:** `fixui dev -- <your dev command>` starts the bridge on an OS-assigned port, publishes `.fix-ui.json`, runs your dev command as a child, and tears the bridge down on exit. The MCP server Claude Code spawns is now *always* a proxy that finds the bridge through that file. Injection into the page comes from adapters we ship and test.

**Tech Stack:** Unchanged — TypeScript 5.9 strict ESM, pnpm workspace, vitest 3, Playwright, MCP SDK.

## Global Constraints

- **Discovery file** `.fix-ui.json`, project root, mode `0600`, replacing `.fix-ui.token`:
  `{ "v": 1, "port": <number>, "token": "<string>", "pid": <number> }`. Written before the dev command starts; removed on exit. Gitignored.
- **No fixed port.** `--port`/`FIXUI_PORT` win; otherwise bind `0` and publish the assigned port. The 3499 default is removed.
- **Two roles, decided by how the process starts:**
  - `fixui dev` → **owner**: binds, writes discovery, spawns the dev command, cleans up.
  - spawned by an agent over stdio (`.mcp.json`) → **proxy**: reads `.fix-ui.json`, forwards to the owner. If no live owner, its tools return an explanatory error naming the fix ("start your dev server"), never a silent empty list.
- **Stale discovery is ignored**, never trusted: unreachable or wrong identity → treat as absent.
- **Adapters are shipped code, not agent-authored.** The agent selects from a table and inserts one documented line.
- Everything already binding stays: loopback-only, `Host` check, 256KB cap, `note` ≤10000 / `selector` ≤2000, token-gated `/events` + verdict + `/surfaces`, one review at a time per project, capture-format v1 unchanged.
- Zero new runtime dependencies.
- TDD per task; `pnpm -r typecheck && pnpm -r test && pnpm --filter e2e test` green before each commit.

---

### Task 1: Discovery + the two roles

**Files:** create `packages/bridge/src/discovery.ts`, `packages/bridge/src/dev.ts`; modify `cli.ts`; tests `discovery.test.ts`, `dev.test.ts`, extend `cli.test.ts`.

**Produces:**

```ts
// discovery.ts
export interface Discovery { v: 1; port: number; token: string; pid: number }
export const DISCOVERY_FILE = ".fix-ui.json";
export async function writeDiscovery(dir: string, d: Discovery): Promise<void>;   // 0600
export async function readDiscovery(dir: string): Promise<Discovery | undefined>; // undefined if missing/malformed
export async function removeDiscovery(dir: string): Promise<void>;
export async function liveBridge(port: number): Promise<boolean>;                 // /healthz identity probe
```

`fixui dev -- <cmd...>` (dev.ts): bind port 0 → write discovery → spawn `<cmd>` with stdio inherited → forward SIGINT/SIGTERM to the child → on child exit, remove discovery, stop the bridge, exit with the child's code. The bridge must not outlive the dev command under any exit path.

`cli.ts` when stdin is not a TTY: read discovery; live → proxy; absent/dead → serve MCP whose tools return `"no fix-ui bridge for this project — start your dev server (npm run dev)"`.

- [ ] **Step 1:** Failing tests:

```ts
it("fixui dev writes .fix-ui.json at 0600 with the bound port, and removes it when the child exits")
it("fixui dev exits with the child's exit code and leaves no bridge listening")
it("fixui dev forwards SIGINT to the child and still cleans up")
it("an agent-spawned bridge proxies to the port named in a live discovery file")
it("an agent-spawned bridge with no live owner answers tools with an actionable error, not an empty list")
it("a discovery file whose port answers nothing is treated as absent")
```

- [ ] Steps 2–4: red → implement → green (spawn the real bin, as `cli.test.ts` already does). **Step 5:** Commit `feat(bridge): dev-owned lifetime and discovery`.

### Task 2: Shipped adapters

**Files:** create `packages/embed/src/next.tsx`, `packages/embed/src/vite.ts`, `packages/embed/src/global.ts`; add a `build` script producing `dist/fixui.global.js` (esbuild IIFE); export `./next`, `./vite` from package.json. Tests alongside.

**Produces:**

```tsx
// next.tsx — SERVER component (no "use client")
export async function FixUiScript(props?: { label?: string }): Promise<JSX.Element | null>;
```
Returns `null` in production. Otherwise reads `.fix-ui.json` (walking up to the nearest `package.json`) and renders the existing client `<FixUi bridgeUrl token label />`. No discovery file → still renders the picker with no bridge (it queues), and logs one line saying the dev server isn't running under `fixui dev`.

```ts
// vite.ts
export function fixui(options?: { label?: string }): Plugin;   // apply: "serve" only
```
`configureServer` reads discovery; `transformIndexHtml` injects the global script with port and token inlined.

`global.ts` → `dist/fixui.global.js`: an IIFE that reads `port`/`token`/`label` from its own `<script data-*>` attributes and calls `initFixUi`. This is the plain-HTML adapter.

- [ ] Failing tests: production → null; discovery present → client gets that port/token; discovery absent → renders, no throw; walks up; vite plugin only applies on serve and injects once; global script reads its data attributes.
- [ ] Commit `feat(embed): Next, Vite and global-script adapters`.

### Task 3: `fixui init`

**Files:** create `packages/bridge/src/init.ts` + `init.test.ts`; wire the subcommand.

In the target directory, idempotently:
1. `.claude/skills/fix-ui/` ← SKILL.md + adapters.md
2. `.mcp.json` ← merge the `fixui` entry, preserving existing servers
3. `CLAUDE.md` ← append the fix-ui line, never duplicating
4. `.gitignore` ← `.fix-ui.json`, `.fix-ui.jsonl`, `.fix-ui.reviews.jsonl`
5. **Detect the stack** and, when confident, make the two edits: wrap the `dev` script as `fixui dev -- <original>`, and insert the matching adapter line. Unsure → print the table and leave it to the agent.
6. Print what changed and the single next step.

Detection: `next` in dependencies → Next (app router if `app/layout.*` exists, else pages); `vite` in devDependencies → Vite; neither → unknown.

- [ ] Failing tests for each effect, for both detected stacks, for the unknown case, and for idempotence (running twice is a no-op).
- [ ] Commit `feat(bridge): fix-ui init`.

### Task 4: `set_picker`

**Files:** modify `broker.ts`, `server.ts`, `mcp.ts`, `packages/core/src/review-channel.ts`, `picker.ts`; tests alongside.

New SSE event `picker` `{ enabled: boolean }`; MCP tool `set_picker({ enabled, surfaceId? })` → arms or disarms picking on one surface, or all of the project's. Unknown surfaceId → the same honest error `request_review` gives.

- [ ] Failing tests: arming a surface arms only that page; disarm turns it off; unknown surface errors.
- [ ] Commit `feat: set_picker`.

### Task 5: Skill — the adapter decision table

**Files:** modify `skills/fix-ui/SKILL.md`; create `skills/fix-ui/adapters.md`.

`adapters.md` is a **selection table**, not a set of recipes for writing code: stack → the adapter to import → the exact line → which file. Plus the `fixui dev` wrapper edit. Plus "not listed → `initFixUi()` in a dev entry."

SKILL.md gains a short "First run" section: detect, pick from the table, make the two edits, **then load the page and confirm the chip exists**. Reporting the integration done from the edit alone is a red flag, same as resolving an unfixed entry.

- [ ] Verify with subagent scenarios against a Next fixture and a Vite fixture: right adapter, right file, verification performed.
- [ ] Commit `docs(skill): adapter selection table`.

### Task 6: Demote the extension; docs; e2e

**Files:** `Makefile`, `README.md`, `docs/*`, `e2e/`.

- The extension leaves the default `make build`; `make build-extension` stays. Its tests keep running so it can't rot silently.
- README and docs lead with `init` + `fixui dev`; the extension is documented as the path for **sites you do not control**, keeping manual bridge URL + token (dynamic ports mean reading them from `.fix-ui.json`).
- Replace every mention of port 3499 and `.fix-ui.token`.
- New e2e: `fixui dev` brings a bridge up and takes it down with the child; a page finds its bridge with no configuration.
- [ ] Commit `docs: dev-owned bridge, init flow, extension demoted`.

---

## What this deletes

The fixed port, `.fix-ui.token`, the machine-wide daemon, the extension's place on the critical path, and every case where a developer copies a token by hand.

## Deliberately not doing

- **A dev-server sink separate from the bridge** — under `fixui dev` the bridge is up whenever the dev server is, so notes don't queue in practice. A second write path would just be two things that can disagree.
- **Agent-authored integrations** — adapters are shipped and tested; the agent selects.
- **Deleting the extension** — demoted, not removed. It is the only answer for sites you do not control.

## Known limitation, documented not solved

A static site with no dev server has nothing to run `fixui dev` or read the discovery file. It needs an explicit `--port` with the token inlined into the global script, or the extension.

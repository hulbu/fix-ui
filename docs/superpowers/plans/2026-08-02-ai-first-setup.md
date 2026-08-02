# fix-ui AI-first setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Reduce setup to `npx fix-ui init`, with the agent performing the app integration itself, and make each project's bridge independent so no session is infrastructure for another.

**Architecture:** The bridge becomes per-project on a dynamic port, publishing `{port, token}` to a discovery file that the app reads server-side — so nothing is ever pasted. A second session on the same project proxies to the first. The framework integration moves out of code and into a skill playbook the agent executes.

**Tech Stack:** Unchanged — TypeScript 5.9 strict ESM, pnpm workspace, vitest 3, Playwright, `@modelcontextprotocol/sdk`.

## Global Constraints

- **Discovery file** `.fix-ui.json` in the project root, mode `0600`, replacing `.fix-ui.token`: `{ "v": 1, "port": <number>, "token": "<string>", "pid": <number> }`. Written before the "listening" log line, removed on graceful shutdown. Gitignored.
- **Port selection:** `--port` / `FIXUI_PORT` wins; otherwise bind `0` (OS-assigned) and publish the actual port. The fixed 3499 default is **removed** — it is what forced machine-wide sharing.
- **Proxy is project-scoped, not port-scoped.** On startup: read `.fix-ui.json` in cwd; if present and `/healthz` confirms a live fixui-bridge, become a proxy to *that* port. Otherwise become the daemon. Never probe a hardcoded port.
- **Stale discovery files are ignored**, not trusted: unreachable or wrong-identity → overwrite and become the daemon.
- Everything already binding: loopback-only, `Host` check, 256KB body cap, `note` ≤10000 / `selector` ≤2000, token-gated `/events` + verdict + `/surfaces`, one review at a time per project, entries unchanged (capture-format v1).
- Zero new runtime dependencies. Bridge stays node stdlib + MCP SDK; core/embed stay zero-dep.
- TDD per task; `pnpm -r typecheck && pnpm -r test && pnpm --filter e2e test` green before each commit.

---

### Task 1: Bridge — dynamic port, discovery file, project-scoped proxy

**Files:**
- Modify: `packages/bridge/src/cli.ts` (port selection, discovery read/write, proxy decision, shutdown cleanup)
- Create: `packages/bridge/src/discovery.ts`
- Test: `packages/bridge/src/discovery.test.ts`, extend `packages/bridge/src/cli.test.ts`

**Interfaces (Produces):**

```ts
// discovery.ts
export interface Discovery { v: 1; port: number; token: string; pid: number }
export const DISCOVERY_FILE = ".fix-ui.json";
export async function writeDiscovery(projectDir: string, d: Discovery): Promise<void>; // 0600
export async function readDiscovery(projectDir: string): Promise<Discovery | undefined>; // undefined on missing/malformed
export async function removeDiscovery(projectDir: string): Promise<void>;
export async function liveBridge(port: number): Promise<boolean>; // /healthz identity probe
```

Startup order in `cli.ts`: `readDiscovery(cwd)` → if found and `liveBridge(d.port)` → proxy to `d.port` using `d.token`; else bind (explicit port, or 0) → `writeDiscovery` → log → serve. `proxyToken` reads the token from the discovery file instead of `.fix-ui.token`. Remove `TOKEN_FILE` and the 3499 constant.

- [ ] **Step 1:** Failing tests:

```ts
it("writes .fix-ui.json with the bound port at 0600 and removes it on shutdown")
it("ignores a discovery file whose port answers nothing and becomes the daemon")
it("ignores a discovery file whose port answers something that is not a fixui-bridge")
it("becomes a proxy when the discovery file names a live bridge, reusing its token")
it("an explicit --port still wins over OS assignment")
it("two bridges in the same project: the second proxies, and list_feedback still works through it")
```

- [ ] **Step 2:** Verify red. **Step 3:** Implement. **Step 4:** Green + spawn-a-real-bin smoke as `cli.test.ts` already does. **Step 5:** Commit `feat(bridge): per-project discovery file and project-scoped proxy`.

### Task 2: Embed — a Next entry point that reads discovery server-side

**Files:**
- Create: `packages/embed/src/next.tsx` (server component), export `./next` from package.json
- Modify: `packages/embed/src/index.ts` (accept `port` as an alternative to `bridgeUrl`)
- Test: `packages/embed/src/next.test.tsx`

**Interfaces (Produces):**

```tsx
// next.tsx — a SERVER component. No "use client".
export async function FixUiScript(props?: { label?: string; project?: string }): Promise<JSX.Element | null>;
```

Behavior: returns `null` when `process.env.NODE_ENV === "production"`. Otherwise reads `.fix-ui.json` from `process.cwd()` (walking up to the nearest `package.json` if not found, mirroring the prototype's workspace-root walk), and renders the existing client `<FixUi bridgeUrl={...} token={...} label={...} />`. When no discovery file exists, render `<FixUi />` with no bridge — the picker still mounts and queues, and logs one line saying the bridge is not running.

**Why this file exists:** the client component cannot read the filesystem; this is the only place the port and token can be picked up without the developer typing them.

- [ ] Failing tests: production → null; discovery present → client component receives that port and token; discovery absent → still renders, no throw; walks up to find the file.
- [ ] Implement, green, commit `feat(embed): Next server entry that discovers the bridge`.

### Task 3: Picker — make a queued note visibly queued

**Files:** Modify `packages/core/src/picker.ts`; test in `packages/core/src/picker.test.ts`

The failure that bit us in production: notes queued invisibly while the bridge was down, and both human and agent believed they were lost.

- Chip badge distinguishes queued from saved (e.g. count plus a dot), and the panel shows a queued row differently from a stored one.
- The saved-notes panel header states it plainly when anything is queued: `"2 waiting for the bridge"`.
- [ ] Failing tests: a queued `create` marks the entry queued in the panel and the badge; a later successful flush clears the marker.
- [ ] Implement, green, commit `feat(core): show queued notes as queued`.

### Task 4: `npx fix-ui init`

**Files:**
- Create: `packages/bridge/src/init.ts`, wire a subcommand in `cli.ts` (`fixui-bridge init` / bin alias)
- Test: `packages/bridge/src/init.test.ts`

Deliberately small — it does **not** touch app code. In the target directory it:
1. Writes/merges `.mcp.json` with the `fixui` server entry (absolute path to this bin), preserving any existing servers.
2. Installs the skill to `.claude/skills/fix-ui/` (SKILL.md + integrations.md).
3. Appends the fix-ui line to `CLAUDE.md`, creating it if absent, and never duplicating on re-run.
4. Adds `.fix-ui.json`, `.fix-ui.jsonl`, `.fix-ui.reviews.jsonl` to `.gitignore` if not present.
5. Prints what it did and the one next step: *"Now tell your agent: fix ui"*.

Idempotent — running twice changes nothing the second time.

- [ ] Failing tests for each of the five effects plus idempotence, in a temp dir.
- [ ] Implement, green, commit `feat(bridge): fix-ui init`.

### Task 5: Skill — the integration playbook

**Files:** Modify `skills/fix-ui/SKILL.md`; create `skills/fix-ui/integrations.md`

SKILL.md gains a short "First run: wire the picker in" section pointing at `integrations.md`, keeping the loop discipline it already has.

`integrations.md` carries one recipe per stack — Next app router, Next pages router, Vite, Astro, SvelteKit, Remix, plain HTML/static, and "framework not listed" (mount `initFixUi()` from the app's dev entry). Each recipe states: the exact file to touch, the exact line to add, and the production-safety property of that line.

**Mandatory verification step in every recipe:** after wiring, load the page and confirm the chip is present — never report the integration done from the edit alone. This is the same rule the skill already enforces for the inbox.

- [ ] Verify with subagent scenarios: give an agent a fixture Next app and the skill; confirm it picks the right recipe, edits the right file, and verifies. Repeat for a Vite fixture and for an unlisted framework.
- [ ] Commit `docs(skill): framework integration playbook`.

### Task 6: Docs and e2e

**Files:** `docs/design.md`, `docs/agent-integration.md`, `docs/architecture.html`, `README.md`, `docs/known-gaps.md`, `e2e/`

- Replace every mention of the fixed 3499 default and `.fix-ui.token` with the discovery file and dynamic port.
- The extension is documented as the path for **sites you do not control**, keeping its manual bridge URL and token config. Note that dynamic ports mean it needs the URL from `.fix-ui.json`.
- New e2e: two bridges in one project (second proxies, both agents' tools work), and a discovery-file round trip where the page finds the bridge with no configuration.
- [ ] Commit `docs: per-project bridge, discovery, and the init flow`.

---

## What this deletes

The fixed 3499 default, `.fix-ui.token`, the machine-wide daemon assumption, the extension's mandatory options-page configuration for the embed path, and every instance of a developer copying a token by hand.

## Deliberately not doing

- **A dev-server sink.** Tempting (notes would never queue), but it duplicates the write path and gives two things that can disagree. Task 3 addresses the real problem — invisible queueing — for far less.
- **Framework plugins.** The agent does the integration; recipes are prose, so a new framework costs paragraphs rather than a package.
- **Extension auto-discovery by port scan.** Only worth building if the extension returns to the critical path.

## Known limitation to document, not solve

A static site with no Node dev server has nothing to read `.fix-ui.json`. That case needs an explicit `--port` and an inlined token, or the extension. State it in the recipes; do not engineer around it.

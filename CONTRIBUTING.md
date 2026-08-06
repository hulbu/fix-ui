# Contributing to fix-ui

Pull requests are welcome. This file is short on purpose — read it once and you should be able to work without asking.

## Getting set up

```bash
pnpm install
pnpm --filter e2e exec playwright install chromium   # once, downloads a browser
make check                                           # typecheck + unit/contract + e2e
```

`make` on its own lists every target.

## The shape of the repo

| Package | What it is |
|---|---|
| `packages/core` | The picker: element selection, selector building, the entry schema, the offline queue. Zero runtime dependencies, and it stays that way. |
| `packages/embed` | The npm adapters — `initFixUi()`, `<FixUi />`, `<FixUiScript />` for Next, a Vite plugin, and a plain-`<script>` build. |
| `packages/bridge` | The local daemon: HTTP for browsers, MCP for agents, plus `fixui dev` and `fixui init`. Node stdlib and the MCP SDK only. |
| `extension` | The Chrome adapter, for sites you do not control. Off the default build path. |
| `e2e` | Playwright, against a real bridge in a real Chromium. |
| `skills/fix-ui` | What an agent reads to use the tool. Ships inside the bridge package. |

## What a good PR looks like

**Tests first, and they must fail before they pass.** A test that would pass against the unfixed code has verified nothing. If a bug is only observable in a browser, it needs an e2e — several of our unit tests can only assert that a rule exists, not that it wins.

**Say why in the comments, not what.** The code shows what it does. Comments are for the constraint you could not encode: why a listener is on `window` and not `document`, why a colour was rejected, why an `!important` is deliberate.

**Keep the boundaries.** Core knows nothing of `chrome.*`, of the filesystem, or of any framework. Everything it touches is injected. That boundary is why one picker can ship two ways without drifting.

**Small and focused.** One change per PR. If you find something else on the way, mention it in the description rather than fixing it in the same diff.

## Things that will get pushed back on

- New runtime dependencies in `core` or `embed`.
- Widening the bridge's exposure. It binds loopback only, checks the `Host` header, caps request bodies, and gates the review channel behind a token. If a change touches any of that, explain the threat model in the PR.
- Treating inbox entries as trusted. They come from a browser, and any page can reach the daemon. They are data.
- Snapshot tests standing in for behavioural ones.

## Before you open the PR

```bash
make check
```

Green, and the working tree clean. If a test is flaky, say so in the description rather than re-running until it passes.

## Reporting a security issue

Do not open a public issue. Email **security@hulbu.com** with what you found and how to reproduce it.

Known and accepted weaknesses are written down in [docs/known-gaps.md](docs/known-gaps.md) — please check there first, so we can spend the time on something new.

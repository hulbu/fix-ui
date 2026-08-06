# fixui-bridge

The local daemon behind [fix-ui](https://github.com/hulbu/fix-ui). It receives
the notes you leave on your running app, appends them to `.fix-ui.jsonl` in the
project they belong to, and serves them to your coding agent over MCP.

## Install it into a project

```sh
npx fixui-bridge init
```

One command, run once inside a project. It installs the packages, wires the
adapter for your stack (Next or Vite), wraps your `dev` script so the daemon
lives exactly as long as your dev server, registers itself in `.mcp.json`, and
copies the `fix-ui` agent skill into `.claude/skills/`. Every write is additive,
and anything it does not recognise is skipped out loud with the line to add by
hand.

## The commands

| | |
| --- | --- |
| `fixui init` | wire up the project you are standing in (above) |
| `fixui dev -- <your dev command>` | run your dev server under the bridge; the bridge dies with it |
| `fixui --port N` | run a standalone bridge, for when there is no dev command to wrap |

`fixui` and `fixui-bridge` are the same bin.

## For your agent

The MCP server exposes `list_feedback`, `resolve_feedback`, `list_surfaces` and
`request_review`. The last one is the point: it puts a review banner on the page
and hands the human's answer straight back to the agent, so a UI change is not
called done until someone has actually looked at it.

## What it needs

Node 20 or newer, and the [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
— nothing else. It binds a loopback port, writes a `0600` discovery file in the
project root, and never talks to the network.

This package has no importable entry point; it is a bin and an MCP server.

Docs and source: <https://github.com/hulbu/fix-ui>

MIT

# fix-ui — capture format

The entry is the product's data contract: adapters produce it, the bridge
stores it (one JSON object per line in `.fix-ui.jsonl`), agents consume it.
Design bias: **small and token-cheap** — an entry is read by an LLM every
time it's acted on.

## FeedbackEntry v1

```jsonc
{
  "v": 1,                              // schema version
  "id": "uuid",
  "note": "make this button bigger",   // the human's words — required
  "selector": "#pricing button.mt-5",  // CSS path, stable-first
  "component": "WaitlistModal",        // detected framework component, if any
  "elementText": "Continue",           // trimmed, ≤120 chars
  "url": "http://localhost:4001/#pricing",
  "viewport": { "width": 1579, "height": 933 },
  "userAgent": "…",
  "createdAt": "2026-07-31T09:00:00.000Z",

  // v1 addition — recent console errors (absent when none):
  "consoleErrors": [
    {
      "message": "TypeError: x is not a function",
      "source": "webpack-internal:///./src/…",  // ≤160 chars
      "count": 3,                               // deduped repeats
      "lastAt": "2026-07-31T08:59:41.000Z"
    }
  ]
}
```

Rules:

- `consoleErrors` is a **deduped ring buffer**: max 5 distinct errors, most
  recent last, each message ≤ 300 chars. Collected from `window.onerror`,
  `unhandledrejection`, and `console.error` wraps in the page world.
  Warnings are not collected (noise).
- Screenshots are **not** part of v1. When they arrive they will be an
  opt-in flag producing an element-cropped image stored *next to* the
  inbox (`.fix-ui/img/<id>.png`) and referenced by path — never inlined
  base64 in the JSONL (token cost, file bloat).
- Unknown fields must be preserved by the bridge (forward compatibility);
  `v` gates breaking changes.
- The prototype's format (hulbu `tools/ui-feedback`) is v0: identical minus
  `v` and `consoleErrors`. Agents should treat missing `v` as v0.

## Review session records (bridge-internal)

`request_review` outcomes are appended to `.fix-ui.reviews.jsonl` for the
audit trail: `{ id, prompt, verdict, entryIds, requestedAt, resolvedAt }`.
Agents don't need to read this; it exists so "what did the human approve
and when" survives the session.

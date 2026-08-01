# fix-ui — known gaps

Everything here was found by review, judged not to block v1, and left
deliberately. It is written down so the next person finds it before
rediscovering it. Critical and important findings from the same reviews
were fixed on the branch; these are the residue.

## Residual risk (accepted)

- **`POST /reviews` is ungated.** The review channel (`GET /events`,
  verdict) requires the bridge's token, but the agent-side request cannot:
  a proxy instance has no way to read the daemon's token file. A page can
  therefore raise a review banner carrying text of its choosing, and hold
  a project `busy` until the timeout — it cannot answer the review. Stated
  in agent-integration.md "Privacy and trust". The real fix is a separate
  agent-half credential, which is v2-shaped.
- **The picker's UI is page-readable while a modal is open.** Re-homing
  into the top layer means the page's light DOM, so the extension's closed
  shadow root buys no isolation in that window. `isTrusted` guards the two
  decisions that must be a human's (verdict, note commit); the rest is
  exposed. See design.md picking mechanic 2.

## Correctness

- **Offline delete round-trips badly.** `transport.remove()` ignores the
  local queue and `picker.deleteEntry` bails when the bridge answers
  `false`, so a note taken while the bridge is down cannot be deleted and
  reappears when the bridge returns.
- **The clipboard last resort is effectively unreachable.** It only fires
  from a retry timer, which has no user activation, so the write is
  rejected and swallowed; `attempts` also resets to 0 on reload, so the
  five-failure threshold may never be crossed. Either drive `flush()` from
  the chip click or drop the promise from design.md and surface the stuck
  queue in the panel instead.
- **A storage failure downgrades `changes` to an empty change request** —
  the agent gets `{verdict:"changes", entries:[]}`, which is actionable in
  name only.
- **Project keys are `path.resolve`, not `realpath`.** On macOS a `/tmp`
  vs `/private/tmp` mismatch between adapter and agent silently yields
  `no-reviewer` with a reviewer connected.
- **`broker.stop()` never broadcasts `review-cancelled`**, so a page's
  banner outlives the daemon.
- **Two unmapped origins armed at once ⇒ no delivery and no signal.** The
  ambiguity is resolved safely (deliver to neither), but the agent's call
  then sits held until timeout with nothing on screen. Users need to be
  told to map the origin.
- **Enabling a destroyed picker resurrects it without styles**, leaving
  the page unclickable with no visible UI.

## Hardening

- The MAIN-world component-name token is broadcast in cleartext and the
  first matching reply wins, so a page listener registered at load time
  beats the real one. Component names are influence-only, but the agent
  trusts that field.
- `.fix-ui.token` is written `0600` at creation only; a pre-existing file
  keeps looser permissions.
- `POST /reviews`'s `prompt` has no length cap of its own, only the 256KB
  body cap.
- The extension's fetch proxy reads `storage.sync` on every request.

## Coverage

- The extension's token path (`withToken`) and its SSE→worker→content
  review direction have no test — the review e2e all use the embed.
  A regression there kills the agent→human direction in the extension
  only, silently.
- `launchWithExtension()` failures degrade the whole extension spec to a
  green skip. Narrow the catch to the known load error.
- Untested: body-form `DELETE` notification, same-project multi-subscriber
  and cross-project SSE isolation, the bridge's catch-all rejection net,
  `listUrl`'s already-has-a-query branch.

## Before publishing

- `@hulbu/fixui` depends on `@hulbu/fixui-core` as `workspace:*`; neither
  scoped package sets `publishConfig.access: "public"`; `fixui-bridge`
  would ship an empty tarball without a `prepack` that builds `dist`.
  Core and embed have no `files`, `types`, or per-package README.
- The LICENSE copyright holder ("hulbu") was inferred, not confirmed.
- There is no CI workflow. Its absence is why a broken fresh-clone
  quickstart reached the final review.

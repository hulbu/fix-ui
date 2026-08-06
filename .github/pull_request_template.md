## What this changes

<!-- One or two sentences. What was wrong, or what is new. -->

## Why

<!-- The reasoning that is not visible in the diff. -->

## How it was verified

<!-- Which tests, and how you know they would have failed before the change.
     Browser-observable behaviour needs an e2e — unit tests can assert a rule
     exists but not that it wins the cascade. -->

- [ ] `make check` is green
- [ ] New tests fail without this change
- [ ] No new runtime dependencies in `core` or `embed`
- [ ] If this touches the bridge's exposure (binding, `Host` check, body caps, the review token), the PR explains the threat model

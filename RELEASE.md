# Cortex Release Notes

## v2.0.10 — deps: bump @metafactory/content-filter to layered scanner

Bumps `@metafactory/content-filter` to the layered-scanner refactor (v0.2.0,
the-metafactory/content-filter PR #17, merge SHA `0e4968c`). The package
internals are reworked into an L0 + L1 stack; cortex's `scanPrompt()` facade
in `src/runner/prompt-filter.ts` is unaffected — `filterContentString`
signature and `FilterResult` shape are unchanged.

**Fixes cortex#367 (operational P1).** The content-filter `EN-001` base64
detector previously matched any 21+ char run of `[A-Za-z0-9+/]`, which
false-positived on every GitHub URL path, every commit SHA and any long
slash-delimited path — silently blocking review pings across cortex#358,
#362, #363 and signal#51, #53. The new content-filter adds an entropy-aware
gate: a regex hit is treated as base64 only if it is not a git-SHA-shaped
hex token, not inside a `://` URL or a slash-delimited path of lowercase
path-words, and clears a Shannon-entropy floor (~3.0 bits/char). Real
random-bytes base64 (~4.5-6 bits/char) still flags; URLs, SHAs and code
paths no longer do.

The new L1 layer is a heuristic prompt-injection scorer ported from Rebuff
(ProtectAI, MIT) — offline, zero-config, pure CPU. It runs alongside the L0
regexes and catches paraphrased injection phrasing the regexes miss. Only
its `block` band (near-verbatim known attack phrasing) makes cortex reject;
the `review` band annotates without blocking.

cortex#367 F-1 (the EN-001 regex fix) and F-2 (cortex-side URL/SHA
pre-filter normalization) are resolved by this dependency bump. F-3
(distinguished filter-block message) and F-4 (operator bypass) remain a
separate small cortex-side patch.

Refs cortex#370, cortex#367, content-filter#17.

## v2.0.9 — security: restore originator signature coverage

Fixes a dependency-install staleness that left the envelope `originator`
field outside the signed field set — restoring tamper-detection on the
policy-attribution claim.

PR #358 (cortex#346, v2.0.6) wired myelin#161's `Envelope.originator`
policy-attribution field through cortex on the contract that `originator`
is in myelin's `SIGNABLE_FIELDS`, so tampering it post-sign invalidates the
stack signature and the receiver rejects with a crypto failure. That
contract did not hold on `main`: a worktree `bun install` during an
unrelated rebase resolved the github-commit-pinned myelin dependency to a
cached older tree whose `SIGNABLE_FIELDS` stopped at `target_principal`.
`package.json` and `bun.lock` both pinned the correct SHA the whole time —
only an installed `node_modules/@the-metafactory/myelin` could be stale.

Consequence while stale: `signEnvelope()` signed over the old field set,
`originator` never entered the signed bytes, and tampering it post-sign did
not break the signature — a tamper to a known principal could impersonate
that principal. A clean install resolves the dependency correctly and
restores the property.

This release adds a regression guard
(`envelope-validator.test.ts` — `originator is covered by the signature`)
that signs an envelope carrying an `originator` block, tampers the
principal post-sign, and asserts crypto-verify rejects. A stale install
now fails the test suite here rather than being found in production. The
guard is TDD-proven — it fails against a simulated stale install and
passes against a correct one. (cortex CI does not yet run `bun test`;
wiring the suite into CI so this guard runs there is tracked in
cortex#376.) Closes cortex#366.

## v2.0.7 — chat-path CC failure retry

Chat-dispatch (Discord / Mattermost `@mention` and DM) now retries transient
CC failures up to 3 total attempts before surfacing the apology message,
mirroring the `not_now` / `cant_do` / `wont_do` / `policy_denied` nak
taxonomy that the review-consumer path already enforced. Failure
classification is lifted out of `review-pipeline.ts` into a shared
`cc-failure-classifier.ts` helper; review-consumer behaviour is preserved
byte-for-byte. Operator sees `Still working… (attempt N/3)` between retries
and a `dispatch.task.failed` envelope is emitted on terminal failure for
cross-path observability parity. Closes cortex#360.

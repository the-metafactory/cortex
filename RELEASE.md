# Cortex Release Notes

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

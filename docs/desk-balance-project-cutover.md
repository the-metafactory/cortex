# Balance project creation cutover

Node #3344 adds `balance.project.create` with required `area` and `title` and optional `note`. The area is a connection-qualified reference. Task and project creation share the Balance execution binding, compatibility facade and durable writer routing. Both call the existing `balanceWriter`, which keeps `changeMyDay` as the transaction owner. Inbox creation remains native.

The read declaration includes both creation capabilities. Registration grants no mutation authority. `createBalanceProjectLifecycleWriter` requires an authenticated conversation context, host approval, the journal and bridge, the project's support declaration and its own verified writer lease. `conversationSources.balanceProjectCutover` installs its compatibility route separately from the task route.

Only the principal starts the cutover on a real stack. Before starting it, run the hosted-route probe, record the Day timing baseline and pass the canary check:

```sh
bun scripts/probe-desk-adapter-hosted.ts
bun scripts/probe-desk-adapter-timing.ts --binding fixture
bun scripts/probe-desk-adapter-canary.ts
```

Use the project binding's exact stack, owner (`balance-project`), connection and capability (`balance.project.create`) throughout the writer plan. Apply the approved sequence through `WriterAuthority`: keep both readers available with lifecycle mutation disabled; turn legacy admission off; stop the inventoried workers; drain every known call or import it uncertain; import the immutable source-hashed legacy sidecars idempotently; acquire the next epoch; then enable only the approved executable and facade. Preserve raw proposals, revisions, receipts, owner object IDs and source links. Importing an old confirmation grants no lifecycle dispatch or retry authority.

A failed, unknown or unreadable step keeps creation disabled. Unknown capability mappings, conflicting bindings and a missing record behind an owner fence also disable creation. A hard trigger fences the bridge and does not reopen the legacy writer. A read-only downgrade retains the sidecars and owner fence.

The card's review digest includes the cutover binding and epoch. Existing drafts retain their edits and identities but require fresh approval. Legacy standing permissions display a renewal notice; their replacement binds the connection and reviewed destination. A retry after success returns the same object. An unknown result uses receipt lookup and current readback; a missing current object does not authorize recreation.

Run the permitted live probe on a disposable temporary stack:

```sh
bun scripts/probe-desk-balance-project-cutover.ts
```

It seeds legacy projects, an edited proposal and an unbound standing permission; imports saved receipts and an in-flight operation; runs synthetic supervisor steps; rejects the stale review digest; approves the preserved project card and a native Inbox card in Chromium; repeats approval and reads the project and both transaction receipts from Balance. It uses temporary storage and never starts a real-stack cutover. The shared task probe continues to run as `scripts/probe-desk-balance-cutover.ts`.

After the first real approved project write reads back, the principal commits the validated evidence summary with `scripts/write-desk-adapter-evidence.ts`, including the real commit and CI run, all acceptance-matrix rows, timing, canary and readback evidence. The disposable probe cannot supply real-stack evidence. Legacy deletion stays behind its separate rollout gates.

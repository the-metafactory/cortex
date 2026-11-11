# Flow save cutover

The Flow binding saves a definition in Pulse. It never runs or enables it and never changes a routine. Refs node #3361.

`createFlowCutover` in `src/conversations/domain-adapters/flow/cutover.ts` is the explicit Cortex runtime entrypoint. It uses the Cortex runtime's shared registry, authority bindings, Flow save binding and an authenticated principal session opener. Register the Flow declaration and connector in that shared runtime and retain its connection record. The connection permits `flow.saved.create` at exactly this stack destination. Installation alone enables no mutation.

Pass the returned `lifecycle` as `lifecycles: { flow: lifecycle }` to `conversationSources` or Mission Control's views. Before its durable cutover record exists, Flow uses the existing writer. Once a record exists, the lifecycle seam owns Flow approval and Check. The native writer remains fenced even if that seam is absent after a read-only downgrade. A failed cutover never selects the old writer.

## Disposable verification

Execute on this machine, without a container:

```sh
bun scripts/probe-desk-flow-cutover.ts
bun scripts/probe-desk-adapter-hosted.ts
bun scripts/probe-desk-adapter-timing.ts --binding fixture --baseline-file /tmp/flow-day-baseline.json
bun scripts/probe-desk-adapter-canary.ts
```

The Flow browser probe creates a temporary Cortex runtime and isolated Pulse flows directory, seeds a saved Flow, an edited revision-2 proposal, an interrupted save and an old global permission, and drives the actual conversation card and API. Its supervisor inventory is synthetic; it touches no installed service. Pulse is the actual pinned Flow service. It checks repeated approval, name/hash/conversation readback, Check by the original request ID, permission renewal and native Desk-note creation in the same conversation. The browser CI job retains its screenshot for 90 days.

## Principal-started real cutover

Only the principal starts this on a real stack. Complete the preceding binding's real approved write/readback and evidence summary first. Run the hosted route, record the Day timing baseline and pass the canary check before starting Flow. Do not infer those gates from unit tests or from the disposable probe's synthetic supervisor.

Obtain `inventory()` from the cutover service after installing its dual readers. Use its complete `sources` and `knownCalls` unchanged in the per-binding `WriterPlan`. Inventory every managed legacy mutation entrypoint. An unmanaged writer makes cutover unavailable.

Call `cutover(plan, supervisor, expectedRevision)` with the actual `ManagedWriterSupervisor`, persistent manifest and distinct guarded replacement service. Its methods disable and stop the retired services, verify absent jobs/PIDs and persistent startup removal, and prepare/enable only the guarded executable. The coordinator imports source-hashed sidecars, accounts for each interrupted call as uncertain, verifies the watermark and acquires the next epoch before enabling mutation. Failures leave the durable phase disabled or stopped. Resume the same plan; changes to inventory require explicit reconciliation.

No legacy approval is carried into a lifecycle approval. Proposal IDs, revisions and fields remain intact; the card's review digest changes with the writer identity and epoch. Saved native receipts and conversation links remain intact. Sidecars preserve the raw legacy record and receipt entries. An interrupted legacy save imports without dispatch or retry permission. Check admits a current-policy read and looks up Pulse's original request ID; absence grants no retry permission. Original import evidence remains intact when Check records the discovered object in the conversation journal.

Old Flow grants remain visible as needing renewal. The next save asks for approval; choosing standing permission creates a new Cortex runtime grant restricted to the exact connection, stack destination and `flow.saved.create`. A global conversation selector still covers only that connection's saves. It confers no run, enable or routine authority. Revocation stops future admission.

A hard trigger fences the binding automatically. Keep reads and drafts available, correct the cause and fix forward. There is no mutation rollback to the native writer. The read-only sidecar reader, grant history and receipts remain available after downgrade.

After the first real approved save reads back from Pulse, the principal commits the evidence summary using `scripts/write-desk-adapter-evidence.ts`, with the real commit SHA, CI run ID, complete matrix results, timing and canary evidence. This implementation and its disposable probe do not certify a real-stack cutover or its evidence summary. Legacy deletion remains gated separately.

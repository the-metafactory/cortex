# Balance Inbox task cutover

This slice adds `balance.inbox-task.create`, which turns a Day item into an Inbox task. Its input is the Day item's key and the item's own title. Its destination is the Balance Inbox, a connection-qualified `inbox` reference, so a standing grant binds to the connection and the Inbox rather than to one item. It shares the Balance create binding, compatibility facade and durable writer routing with task and project creation.

The binding calls the existing `balanceInboxWriter`, which reads the Day item through the bounded `deskItems` seam at dispatch. A removed item, or an item whose title differs from the approved one, is refused and nothing is created. The write keeps the item's `sourceIdentity` and logs the mail once. A repeated approval returns the same task from the Balance receipt.

`createBalanceInboxLifecycleWriter` takes the same options as the task and project writers plus `deskItems` and `listedMail`. `conversationSources.balanceInboxCutover` installs its compatibility route separately from the other two. The read declaration includes the new capability. Registration grants no mutation authority.

Only the principal starts the cutover on a real stack. First, perform the hosted-route probe, the timing baseline and the canary check first, then apply the approved sequence through `WriterAuthority` for the writer key `balance-inbox-task` and capability `balance.inbox-task.create`: dual readers with lifecycle mutation disabled, legacy admission off, workers stopped, in-flight calls drained or imported uncertain, idempotent source-hashed sidecar import, next epoch, then the approved executable and facade. A failed or unknown step leaves creation disabled. A hard trigger fences the binding and does not reopen the legacy writer.

Existing drafts keep their edits and identities but need fresh approval, because the review digest includes the cutover binding and epoch. A legacy standing `balance-inbox-task` grant shows a renewal notice, and its replacement binds the connection and the Inbox.

Execute the permitted live probe on a disposable temporary stack:

```sh
bun scripts/probe-desk-balance-inbox-cutover.ts
```

It runs the cutover, approves a matching mail item, repeats the approval, then approves a changed item and a removed item. It reads the Inbox task, its source identity, the Balance receipt and the mail log back. It never starts a real-stack cutover.

After the first real approved write reads back, the principal commits the evidence summary with `scripts/write-desk-adapter-evidence.ts`. Legacy deletion stays behind its separate rollout gates.

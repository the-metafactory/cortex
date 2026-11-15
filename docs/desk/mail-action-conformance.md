# Public Mail action verification

Desk SDK 1.12 adds pure Mail move and reply-draft contract helpers and `runMailActionScenario` from `@the-metafactory/cortex/desk-adapter-conformance`. The runner loads an external fixture package and drives its connector through production approval, dispatch, journal reopening and historical lookup. Host, journal, authority and facade constructors stay internal.

Use only an invented-data package backed by a fake Mail connection. The runner creates a temporary synthetic local conversation and connection, requests no credential, blocks network access and removes its store afterwards. It does not install or activate a package in a running stack. Fixture code must not invoke a real Mail CLI or read production credentials. The report's `credentialRequests: 0` describes the runner's no-credential path, not instrumentation of arbitrary credential access by fixture code.

```ts
import {
  mailAccountRef, mailMessageRef, mailMoveSnapshot,
} from "@the-metafactory/cortex/desk-sdk";
import { runMailActionScenario } from "@the-metafactory/cortex/desk-adapter-conformance";

const report = await runMailActionScenario(fixtureDir, {
  capabilityId: "mail.move",
  mail: fakeMailSource,
  snapshot: context => mailMoveSnapshot({
    ...context,
    account: mailAccountRef(context.adapterId, context.connectionId, context.account),
    input: {
      action: "move",
      message: mailMessageRef(context.adapterId, context.connectionId, "message-example"),
      target: "archive",
    },
  }),
  steps: ["reopen", "reconcile", "reopen", "repeat"],
});
```

The snapshot callback receives only synthetic adapter, connection, account and provenance data. It returns the snapshot's data fields; an existing helper's digest may be included but is recomputed over the supplied data. Normal registry validation, scope checks, confirmation, writer fencing and reconciliation still run. The callback does not supply authority or an authenticated context.

`repeat` dispatches the same operation again. It never creates a second approved attempt. `reopen` closes and reopens the real journal; `reconcile` asks the production reconciler to check the package connector's historical lookup. Up to sixteen steps are allowed. `dispatchWaitMs` bounds the initial dispatch wait between 1 and 10,000 milliseconds and defaults to 100.

The report is evidence, not a passing verdict. Each stage includes the actual journal state, snapshot digest, attempt IDs and receipt entries. The report also retains journal events and connector call counts. Consumers must assert their expected states, correlation and fake-provider effects. Connector `dispatch` counts are distinct from underlying provider calls or mutations: a strict binding can reject a malformed scope before invoking its fake connection.

For timeout-after-effect, assert `uncertain` before lookup, then `succeeded` after lookup and after reopening, with one dispatch, one lookup and one fake-provider mutation. Invalid scope must have no provider mutation. No restore support must leave the action unavailable. These assertions belong to the adapter's probe.

`mailMoveDeclaration` includes the canonical message/account object types and their schemas; an adapter composing this with an existing read declaration must retain all required metadata and avoid conflicting duplicates. The runner does not invent missing package declarations. `mailMoveSnapshot` supplies the matching message target and one account destination. `mailReplyDraftDeclaration` and `mailReplyDraftSnapshot` expose the existing reply contract; the latter preserves the exact untrimmed body and uses the same scope validation as the host.

The synthetic action conversation is local and approvals use exact confirmation. The public consumer tests verify that basis and body preservation. The host's existing reply-draft tests separately cover broad-grant refusal in local conversations and refusal of a cloud-created grant for a local reply; the scenario runner does not claim to execute those grant cases. A cloud-policy snapshot in this local Mail fixture is refused without dispatch.

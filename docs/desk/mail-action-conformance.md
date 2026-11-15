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

For timeout-after-effect, assert `uncertain` before lookup, then `succeeded` after lookup and after reopening, with one dispatch, one lookup and one fake-provider mutation. Invalid scope must have no provider mutation. The production reply policy rejects malformed reply scope before connector dispatch. For moves, registry/connection authorization rejects a foreign account destination before dispatch, while the strict Mail binding owns empty-destination and mismatched-target refusal after dispatch and before any provider call. Tests assert these distinct boundaries; the runner adds no move mutation policy. No restore support must leave the action unavailable. These assertions belong to the adapter's probe.

`mailMoveDeclaration` includes the canonical message/account object types and their schemas; an adapter composing this with an existing read declaration must retain all required metadata and avoid conflicting duplicates. The runner does not invent missing package declarations. `mailMoveSnapshot` supplies the matching message target and one account destination. `mailReplyDraftDeclaration` and `mailReplyDraftSnapshot` expose the existing reply contract; the latter preserves the exact untrimmed body and uses the same scope validation as the host.

The synthetic action conversation is local and approvals use exact confirmation. The public consumer tests verify that basis and body preservation. The host's existing reply-draft tests separately cover broad-grant refusal in local conversations and refusal of a cloud-created grant for a local reply; the scenario runner does not claim to execute those grant cases. A cloud-policy snapshot in this local Mail fixture is refused without dispatch.

## Packaged Mail execution and recovery

SDK 1.13 adds optional `host.mailExecution`. A package still exports only `createDeskAdapter(host)` and registers its action connectors normally. It does not construct a provider from ambient commands, account names or environment settings. In Cortex's bootstrap, `DeskPackageLoaderOptions.mailExecution` supplies a connection selector over the existing host-owned source/account bindings and access to the existing operation journal. This is host integration, not a second package configuration mechanism. No connection is enabled, no native path is removed, and no real Mail operation is started by installation or this API.

The selector can return an existing version-1 Mail connection, including Helm's `CliConnection` or a fake implementing the same methods. The package receives neither that object nor credentials. `bridge.connection(connection)` returns only its version and supported method names, or `null` when the provider is absent or its version is missing/unsupported. A package must leave such actions unavailable; it must not substitute a native or fake connection. A connection's metadata grants no execution permission.

Check that metadata includes the action's required methods before declaring it available: draft plus lookup, unsubscribe plus lookupUnsubscribe, or move/restore/lookupMove for moves and Trash. The bridge also refuses provider calls missing those recovery methods. Trash has no non-restorable fallback.

Inside a host-admitted action callback, use `bridge.invoke(connection, method, input)`. Inputs have these exact fields; extra fields such as draft `cc`/`bcc`, unsubscribe URLs, headers or command overrides are rejected before calling the provider.

| Method | Native version-1 input |
| --- | --- |
| `draft` | `{ version, requestId, account, messageId, recipient, subject, body }` |
| `move` | `{ version, requestId, account, messageId, context, action, target }`, with `action: "move" \| "trash"` and the approved `archive`/`junk`/`trash` target |
| `restore` | `{ version, requestId, account, messageId, context, action: "restore", from }`, preserving the approved location precondition |
| `unsubscribe` | `{ version, requestId, account, messageId, context }`; the bound source must list RFC one-click headers, and the provider owns their execution |
| `lookup`, `lookupMove`, `lookupUnsubscribe` | The exact `requestId` string for the admitted operation and its capability |

`version` is the existing native interface number `1`. `requestId` is `${capabilityId}:${ownerRequestId}`, using the approved operation's identifiers, and follows the native interface's 1–200 character `[A-Za-z0-9._:@-]` format. `context` is `{ operationId, attemptId, snapshotDigest }`. Every mutation is checked against the exact admitted snapshot, its message target and its single host-bound account. Draft text is never trimmed. Its recipient comes from the listed sender, and its subject is `mailReplySubject(listed.subject)` from the public SDK, sharing the native reply helper. A method from another capability is refused. The method set contains no send or arbitrary command call.

Completed callbacks and aborted host dispatch/lookup signals cannot start another provider call. This fences delayed work before it reaches the provider; it does not cancel an effect already started by a native connection that offers no cancellation. Such an uncertain effect still needs historical lookup.

One-click eligibility is projected in listed mail as `unsubscribe?: { oneClick: true, host }`. Raw headers and unsubscribe URLs are never released in that projection. The native provider retains its own endpoint validation and duplicate-suppression responsibilities. This bridge supplies no new grant and does not replace the unsubscribe warning or local-only reply policy.

In a connector's `lookup(request)` callback, `bridge.lookupContext(connection, request)` returns the immutable original operation/attempt IDs, owner request ID, snapshot digest and approved snapshot from the host's durable journal. It accepts only the exact admitted lookup for that same connection. It does not expose the journal or an authority constructor. Use those original IDs when building the owner result from the provider's historical evidence; never reuse an in-memory dispatch result or mint a new attempt. Lookup methods are restricted to this capability's owner request. Historical move evidence with a different action, message, account or attempt is refused.

For a fake-only acceptance run, add `execution: { connection: binding => fakeConnectionFor(binding) }` to `runMailActionScenario`. That uses the same production loader and host-selected binding path as Cortex integration. `steps: ["restart", "reconcile", "restart", "repeat"]` recreates the loader, calls the package factory again, creates a new connector and reopens the conversation host over its existing durable journal. The report counts these reconstructions. `reopen` retains its previous journal-only meaning. Provider effects needed across a restart must survive in real provider data; test fixtures must persist that data independently of the discarded connector. A constructor counter, one dispatch/lookup/effect, stable original IDs and final receipts prove this boundary. The scenario is a controlled in-process reconstruction, not a claim that an operating-system process was killed or that a live deployment was tested.

## Staged inactive packaging

Helm's existing `adapter/` artifact deliberately declares reads only, and its package tests and read probe require full generic conformance with no action connectors. Keep that artifact and those checks intact while building the inactive Mail bindings. A separately built, committed action-generation candidate can retain the canonical read metadata and add the scoped action declarations and connectors. Its sole export remains `createDeskAdapter(host)`, and dedicated Mail scenarios must load that real built manifest/backend pair through the public loader. A source-only factory that the artifact never calls is insufficient.

The read generation and action candidate are alternatives for the same adapter identity, not two adapters to configure together. Only an explicitly selected candidate path enters the controlled fixture run; deployment activation and removal of the native Mail path remain separate gated work. Generic `runConformance` and its failure runner retain their existing behavior: they do not construct canonical Mail action approvals or supply the new execution provider. Dedicated Mail scenarios, including negative and reconstruction cases, are the action acceptance surface. Passing the unchanged read artifact's checks does not claim action acceptance.

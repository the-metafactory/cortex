# Pi Durable qualification under Bun

Refs [Ivy conversations: qualify Pi Durable persistence and recovery under Bun](https://github.com/the-metafactory/cortex/issues/2960). Research captured on 2026-11-01. This artifact does not select the production host.

## Finding

The pinned release can retain and recover the required conversation record under the tested Bun runtime. Its default unsafe-tool recovery exposes an uncertain result after a crash instead of repeating the owner operation. It is not a complete Cortex conversation host: cross-process ownership, conflicting-request validation, authorization, privacy, transports, attachment storage, and owner reconciliation remain host responsibilities.

The principal's subsequent architecture decision must weigh those responsibilities. This qualification does not adopt the library, add a fallback engine, move scheduling from Reflex or Pulse, or bypass creation owners and graph checkpoints.

## Reproduce

Run these commands from this directory:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run qualify.ts > results-new.jsonl 2> stderr-new.txt
```

The second command exits zero and ends with `{"qualification":"completed","productionAdoption":false}`. Child processes have 25-second deadlines. Each declared crash waits at most 20 seconds for its checkpoint before sending SIGKILL. Stores and the simulated owner ledger live in a newly created temporary directory and are removed afterward. The fake provider is the only registered provider, and `fetch` rejects network requests. No credentials, production data, Discord messages, or paid model calls are used.

The manifest and lockfile pin `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and `@earendil-works/chord` to **1.4.0**, including the transitive dependency graph. The measured executable is Bun **1.4.3**, macOS arm64, with Bun's Node compatibility version **26.3.0** and SQLite **3.51.0**. The selected storage is the released `openNodeSqliteStorage` adapter from Durable, backed by Chord **1.4.0** and `node:sqlite`. Import and actual persistence operations succeeded under this Bun version. This is not a claim about all Bun versions. An earlier shell baseline printed Bun 1.4.2; every recorded qualification child uses the parent's exact executable, and the results' version record is authoritative.

The released package declares Node `>=22.19.0`. Its registry metadata is in [registry.json](registry.json). The dependency is isolated from Cortex's production dependencies. Cortex's root TypeScript and ESLint projects exclude this directory. A separate workflow, filtered to this artifact's paths and pinned to Bun 1.4.3, installs without lifecycle scripts and runs its own typecheck, ESLint check, and qualification with read-only repository permission and no secrets. [tsconfig.json](tsconfig.json) defines that research typecheck. CI re-execution on Linux is distinct from the captured macOS transcript.

## Requirement-to-result matrix

Each `command` record in [results.jsonl](results.jsonl) includes its actual exit code and the child's output. Child output is JSON text within that record. These are observations from [qualify.ts](qualify.ts), not inferred guarantees.

| Requirement | Command or result key | Observed result |
| --- | --- | --- |
| Messages and attachment reference | `write normal.sqlite normal`, then `reopen normal.sqlite normal` | The fresh process reads `pi.user`, assistant messages, and the sample `app.attachment` URI, media type, and digest. Attachment bytes and access controls are outside this test. |
| Tool activity and results | Same commands, `toolResults` and `entries` | The tool call and its correlated `scratch-object-1` result survive reopen. |
| Decisions and created-object provenance | Same commands, `app.decision` and `app.created` | The decision survives. After a successful owner result, the writer appends provenance with the actual submission ID, answer ID, owner correlation, and object. `app.provenance-fixture` is an independent retention specimen, never proof that an effect occurred. |
| Crash during model request | `write during-model.sqlite during-model` exits 137; subsequent `reopen` exits zero | The admitted input survives. Resume supplies a deterministic replacement answer. No owner effect occurred. This does not test a remote provider's billing or cancellation semantics. |
| Crash after committed tool intent, before effect | `before-owner` writer exits 137, reopen exits zero | The ledger has zero effects. Durable emits `interrupted`, saying the tool may have partially run. The unsafe tool does not replay. |
| Crash after effect, before tool result commit | `after-owner` writer exits 137, reopen exits zero | The independent ledger has one effect. Durable emits the same explicit uncertainty and does not replay. The owner request ID is correlation, not proof of exactly-once effects. |
| Crash after committed tool result and provenance | `after-result` writer exits 137, reopen exits zero | One owner effect remains, with its successful tool result and created-object provenance. No repeated effect appears. |
| Duplicate after process reconnect | Every `reopen` | Reusing `input-1` returns the original submission ID, without another user entry or effect. |
| Conflicting payload under the same ID | Every `reopen`, `conflictBehavior` | A different payload silently returns the original submission. The replacement text is absent from the transcript. A Cortex ingress wrapper would need to reject mismatched payloads explicitly. |
| Two clients see order and queue | `clients clients.sqlite`, `two-clients` | Two independently attached watches on one host observe the same final committed entry order. Both callbacks receive that state. Both see the queued follow-up and steer. These are host clients, not real web or Discord transports. |
| Explicit steering at safe boundary | Same command, `toolIndex`, `steerIndex`, `followIndex`, `requests` | The first model request is deliberately held. The default follow-up queues; a steer queues separately. The owner result precedes the steer, and the follow-up enters after the run answers. A busy `reject` submission fails explicitly. |
| Compaction retains originals | `compaction-model-change`, then `verify-compaction clients.sqlite` in a fresh process | The real compaction task completes and appends `pi.compaction`. Every original entry is compared byte-for-byte before and after compaction and after process reopen. All 80 long history entries remain retrievable through `entries()`. |
| Idle model change reconstructs context | Same commands, `selectedModel`, `reconstructed` | Idle `configure()` selects the second fake model. Its request includes the compact working summary, and the selected model survives reopen. No native CLI session state is transferred. |
| Second writer exclusion | `lock lock.sqlite`, `raw-open lock.sqlite` | An atomic host-owned directory lock excludes the second host process. The raw released SQLite adapter still permits another open. The exclusion is the qualification host's mechanism, not an upstream guarantee. |
| Lock owner crashes | Second `lock lock.sqlite` after the holder's SIGKILL | The remaining lock excludes reopening. Automatic stale-owner recovery is not implemented or proven. Production needs an ownership and reconciliation design. |

## Limits and actual failures

The selected SQLite adapter configures WAL with `synchronous=NORMAL`: see the locked package `@earendil-works/chord/dist/sqlite/node.js`, `openNodeSqliteDatabase`. The observed SIGKILL tests establish process-crash recovery at the named checkpoints. They do not establish host or power-failure durability, filesystem guarantees, recovery from disk corruption, or zero loss of in-flight streaming progress. No power-failure experiment was performed.

The installed release's source is the API authority for this artifact. Its `dist/harness/types.d.ts` declares `watch.start(listener(value, ops, context))` with an async listener, and `watch(context)` without window options. Its view exposes the active transcript. The upstream main README inspected during research describes a newer tagged `WatchCall` callback and window options. Those APIs must not be copied into a 1.4.0 integration without checking the release. The qualification initially used the newer callback shape; typecheck found the mismatch, and the final callback assertions verify both clients' deliveries. The final artifact is typechecked separately.

The initial fake tool response also omitted the required `stopReason: "toolUse"`. That made the normal path finish without executing the tool, and the effect-count assertion failed. [initial-failure.jsonl](initial-failure.jsonl) and [initial-failure-stderr.txt](initial-failure-stderr.txt) retain that failing command. The corrected response uses the released fake-provider API. This was a probe bug, not an upstream recovery failure. An unscoped `pi-durable/1.4.0` registry request returned HTTP 404; the actual package is scoped as recorded in the manifest.

Only the faux provider was exercised. Local model endpoints, Claude and Codex subscription authentication, paid providers, provider retries, remote deferred responses, and private native session transfer remain unqualified. JSONL, IndexedDB, Cloudflare storage, and custom Bun SQLite adapters were not exercised. The package documents JSONL and portable adapters, but documentation is not a passed probe. The fake owner records one deterministic operation and cannot establish an external service's idempotency contract.

The module contains its own durable task scheduler. This test invokes it for a submitted conversation and uses no scheduled reminders or flows. Whether to expose that scheduler behind a narrowly scoped Cortex-owned host is a subsequent architecture decision. Reflex remains the routine scheduling owner, Pulse remains the flow owner, and actual object creation must call its authoritative owner.

## Source references

The following exact installed files can be recovered from [bun.lock](bun.lock), which pins their package versions and integrity hashes:

- `@earendil-works/pi-durable/dist/harness/types.d.ts`: `SubmissionDraft`, `Submission`, `Conversation`, `AgentChange`, and `HarnessSettings`.
- `@earendil-works/pi-durable/dist/harness/view.d.ts`: `ConversationView` and the release's observer callback shape.
- `@earendil-works/pi-durable/dist/types.d.ts`: `EntryRecord`, `Page`, and `WatchHandle`.
- `@earendil-works/pi-durable/dist/storage/sqlite/node.js`: delegates to the Chord SQLite adapter.
- `@earendil-works/chord/dist/sqlite/node.js`: serialized connection operations, Node `DatabaseSync`, WAL, and NORMAL synchronous policy.
- `@earendil-works/pi-ai/dist/providers/faux.js`: scripted provider, default `stopReason: "stop"`, tool-call response support.

Primary upstream references are the [package README](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md) and [announcement](https://earendil.com/posts/pi-durable/). They are mutable documentation and do not supersede this pinned experiment.

## Delivery evidence

The PR verification records Cortex typecheck, the separate qualification typecheck, changed-file ESLint, the duplication gate, and the SOP's focused Cortex test suite. Review and CI outcomes are recorded on the PR. This research changes no live service, so production deployment and a live Desk probe do not apply. The executable scratch-store qualification is the node's requested probe.
